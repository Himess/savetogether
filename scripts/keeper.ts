/**
 * The keeper: reveals draws and accrues every participant.
 *
 * Self-healing in the sense GhostLend's keeper is — it does not assume it was
 * running last time. On every tick it first repairs whatever it finds unfinished,
 * then does new work. A keeper that only handles the happy path leaves a draw
 * stuck in Open forever after one dropped receipt, and here that is worse than an
 * outage: accrual is what stands in for claiming, so a keeper that stops is a
 * keeper that has turned "who transacted" back into a signal.
 *
 * Two properties make the repair safe to run blindly:
 *
 *   - `revealDraw` reverts `DrawNotOpen` if the draw was already revealed, so
 *     re-running it costs a failed estimate and nothing else.
 *   - `accrue` returns early on an already-accrued (user, draw), so re-running a
 *     chunk after a lost receipt is normal rather than an error.
 *
 * Participants are enumerated from `Deposited` events, which is sound because the
 * event carries the address in the clear — that is public by construction, and
 * documented as such in docs/leakage.md.
 *
 *   POOL=0x... npx hardhat run scripts/keeper.ts --network sepolia
 *   POOL=0x... ONESHOT=1 npx hardhat run scripts/keeper.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { Contract, EventLog } from "ethers";

const POOL = process.env.POOL ?? "";
const ONESHOT = process.env.ONESHOT === "1";
const CHUNK = Number(process.env.CHUNK ?? 4); // see accrueAll: six COLD accruals do not fit
const PERIOD_SECONDS = Number(process.env.PERIOD ?? 300);
const TICK_MS = Number(process.env.TICK_MS ?? 30_000);

const log = (s: string) => console.log(`[keeper] ${s}`);

/** Every address that has ever deposited. Public by construction. */
async function participants(pool: Contract): Promise<string[]> {
  const events = await pool.queryFilter(pool.filters.Deposited(), 0, "latest");
  const seen = new Set<string>();
  for (const e of events) {
    const user = (e as EventLog).args?.[0] as string | undefined;
    if (user !== undefined) seen.add(ethers.getAddress(user));
  }
  return [...seen];
}

/** Turns an Open draw into a Revealed one. Safe to call on a draw that is neither. */
async function reveal(pool: Contract, drawId: number): Promise<boolean> {
  const d = await pool.drawAt(drawId);
  if (Number(d.status) !== 1) return false;
  log(`draw ${drawId} is Open — requesting public decryption`);
  // Order matters and is not checkable at runtime: revealDraw rebuilds
  // [encR, encTotalWeight] from storage, and abi.decode is positional, so a
  // swapped pair decodes into the wrong fields silently.
  const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
  const tx = await pool.revealDraw(drawId, pub.abiEncodedClearValues, pub.decryptionProof);
  await tx.wait();
  const after = await pool.drawAt(drawId);
  log(`draw ${drawId} revealed — R ${after.r}, totalWeight ${after.totalWeight}`);
  return true;
}

/**
 * Accrues everyone who is still owed this draw.
 *
 * Chunked at the measured limit, and the limit here was wrong until it was run.
 * This comment used to say six left headroom for a cold cache. It does not:
 * cold accrual is 3,537,224 HCU (findings §11.1) and six of those is 21.2M
 * against a 20M per-transaction ceiling. Six WARM ones fit at 2.58M each; six
 * cold ones revert with a bare `execution reverted` out of `estimateGas`, which
 * is exactly what happened while seeding the V2 pool. Four cold is 14.1M and
 * fits with room, so four is the default.
 */
async function accrueAll(pool: Contract, drawId: number): Promise<number> {
  const users = await participants(pool);
  const owed: string[] = [];
  for (const u of users) {
    if (!(await pool.accrued(drawId, u))) owed.push(u);
  }
  if (owed.length === 0) return 0;

  log(`draw ${drawId}: ${owed.length} of ${users.length} still owed`);
  let done = 0;
  for (let i = 0; i < owed.length; i += CHUNK) {
    const chunk = owed.slice(i, i + CHUNK);
    try {
      await (await pool.accrueMany(chunk, drawId)).wait();
      done += chunk.length;
      log(`  accrued ${done}/${owed.length}`);
    } catch (e) {
      // One bad chunk must not strand the rest: every (user, draw) is
      // independent, so the next chunk is unaffected and this one is retried on
      // the following tick.
      log(`  chunk ${i / CHUNK} failed, will retry next tick: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return done;
}

/**
 * Moves accrued yield into the reserve prizes are paid from.
 *
 * Without this the machine runs perfectly and pays nothing: the reserve starts
 * empty and fills from `harvest()` alone, so every draw awards a prize the
 * encrypted balance cannot cover, `tryDecrease` declines, and the winner is
 * credited zero — silently, because a failed award is indistinguishable from a
 * loss by design. The first live round on the composed pool did exactly that.
 *
 * Permissionless and idempotent, so a failure here is worth a line and not a
 * stall: the next tick harvests again, and a draw with an unfunded reserve is
 * still a valid draw.
 */
async function harvest(pool: Contract): Promise<void> {
  try {
    // Read the clock BEFORE harvesting. `harvest` settles the source, so asking
    // afterwards returns an elapsed of about one second and a break-even of
    // three million — a diagnostic that cries wolf every round, which is worse
    // than not having one.
    const since = await elapsedSinceSettle(pool);
    await (await pool.harvest()).wait();
    await logBreakEven(pool, since);
  } catch (e) {
    log(`harvest failed, opening anyway: ${(e as Error).message.slice(0, 80)}`);
  }
}

async function elapsedSinceSettle(pool: Contract): Promise<bigint> {
  try {
    const src = new ethers.Contract(
      await pool.yieldSource(),
      ["function lastAccrual() view returns (uint40)"],
      ethers.provider,
    );
    const now = BigInt(Math.floor(Date.now() / 1000));
    return now - BigInt(await src.lastAccrual());
  } catch {
    return BigInt(PERIOD_SECONDS);
  }
}

/**
 * Prints the principal this round needed, every round.
 *
 * Whether a harvest actually covered the prize is not knowable off chain — both
 * numbers are encrypted, and that is the point of the contract. But the
 * THRESHOLD is entirely public: `yield = principal x rateBps x elapsed / (10000 x
 * 365 days)`, so the principal at which a round breaks even follows from the
 * rate, the elapsed time and the prize, all of them readable.
 *
 * This exists because the alternative already happened. The reserve fills from
 * harvest alone, a prize the reserve cannot cover credits the winner ZERO, and
 * `tryDecrease` declining looks exactly like losing — so the pool ran for hours
 * paying nothing while every log line said it was healthy. A number that has to
 * be beaten, printed next to the round that has to beat it, is the cheapest way
 * to stop that from being invisible a second time.
 */
async function logBreakEven(pool: Contract, elapsed: bigint): Promise<void> {
  try {
    const src = new ethers.Contract(
      await pool.yieldSource(),
      ["function rateBps() view returns (uint64)"],
      ethers.provider,
    );
    const rate = BigInt(await src.rateBps());
    const prize = BigInt(await pool.prize());
    // A backlog catch-up can settle seconds apart; the number worth printing is
    // the one for a normal round, so the period is the floor.
    const seconds = elapsed < BigInt(PERIOD_SECONDS) ? BigInt(PERIOD_SECONDS) : elapsed;
    const YEAR = 31_536_000n;
    const breakEven = (prize * 10_000n * YEAR) / (rate * seconds);
    log(
      `harvest ok — over ${seconds}s at ${Number(rate) / 100}%/yr this round needs ` +
        `~${(Number(breakEven) / 1e6).toLocaleString("en-US")} cUSDC of principal to fund the prize`,
    );
  } catch {
    // Never let a log line take the keeper down.
  }
}

async function tick(pool: Contract): Promise<void> {
  const count = Number(await pool.drawCount());

  // 1) Repair first. An Open draw blocks every later one, so it is the only
  //    thing that can wedge the machine.
  for (let id = count; id >= 1 && id > count - 3; id--) {
    if (await reveal(pool, id)) break;
  }

  // 2) Settle outstanding accruals, oldest first, so a participant is never
  //    skipped because a newer draw arrived.
  for (let id = 1; id <= count; id++) {
    const d = await pool.drawAt(id);
    if (Number(d.status) !== 2) continue;
    await accrueAll(pool, id);
  }

  // 3) Only then open new work — and fund it first.
  if (count === 0) {
    try {
      await harvest(pool);
      await (await pool.openDraw()).wait();
      log(`opened draw 1`);
    } catch (e) {
      log(`cannot open the first draw yet: ${(e as Error).message.slice(0, 90)}`);
    }
    return;
  }

  const last = await pool.drawAt(count);
  const now = Math.floor(Date.now() / 1000);
  if (Number(last.status) === 2 && now >= Number(last.snapshotAt) + PERIOD_SECONDS) {
    await harvest(pool);
    await (await pool.openDraw()).wait();
    log(`opened draw ${count + 1}`);
  }
}

async function main(): Promise<void> {
  if (POOL === "") throw new Error("set POOL=0x...");
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, signer);
  log(`watching ${POOL} as ${await signer.getAddress()}`);
  log(`period ${PERIOD_SECONDS}s, chunk ${CHUNK}, tick ${TICK_MS}ms`);

  for (;;) {
    try {
      await tick(pool as unknown as Contract);
    } catch (e) {
      log(`tick failed, continuing: ${(e as Error).message.slice(0, 160)}`);
    }
    if (ONESHOT) return;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
