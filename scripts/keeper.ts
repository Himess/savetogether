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
    await (await pool.harvest()).wait();
  } catch (e) {
    log(`harvest failed, opening anyway: ${(e as Error).message.slice(0, 80)}`);
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
