/**
 * X1 — can a single deposit be recovered from consecutive draws?
 *
 * `STATE-NOW.md` §1 derives the pool's total balance from public data:
 *
 *     totalWeight / window = total balance
 *
 * and used it to validate a reading. The same arithmetic points the other way.
 * `totalWeight` is the aggregate of balance-seconds over the window, so:
 *
 *     totalWeight_N = prevBalance * window + delta * (snapshotAt - eventTime)
 *
 * The window is public. The `Deposited` event's timestamp is public. `prevBalance`
 * comes from the previous draw's own totalWeight. **If exactly one balance-changing
 * event lands in a window, `delta` is the only unknown and the equation solves.**
 *
 * This script does not assume that. It finds windows with exactly one such event,
 * solves for `delta`, and prints the result beside the true amount so the claim can
 * be checked rather than believed.
 *
 *   npx hardhat run scripts/x1-window-solve.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";

const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";
const FROM_BLOCK = 11_620_350;

const DEPOSITED = ethers.id("Deposited(address,uint40,uint256)");
const WITHDRAWN = ethers.id("Withdrawn(address,uint40,uint256)");
/**
 * `Claimed` moves a balance too, and leaving it out is how a first pass gets the
 * wrong answer: `_drain` folds a pending credit into the balance and pushes a new
 * observation, so a claim changes `totalWeight` exactly as a deposit does. The
 * attack needs EVERY balance-changing event to isolate a single unknown; an
 * incomplete filter under-counts events and mis-attributes the residual.
 */
const CLAIMED = ethers.id("Claimed(address,uint40)");

async function main(): Promise<void> {
  const p = ethers.provider;
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  const latest = await p.getBlockNumber();

  // Balance-changing events, with their on-chain timestamps.
  const logs: { kind: "deposit" | "withdraw" | "claim"; who: string; t: number; tx: string }[] = [];
  for (let f = FROM_BLOCK; f <= latest; f += 9000) {
    const to = Math.min(f + 8999, latest);
    let batch: ethers.Log[] = [];
    try {
      batch = await p.getLogs({ address: POOL, fromBlock: f, toBlock: to, topics: [[DEPOSITED, WITHDRAWN, CLAIMED]] });
    } catch {
      continue;
    }
    for (const l of batch) {
      const blk = await p.getBlock(l.blockNumber);
      logs.push({
        kind: l.topics[0] === DEPOSITED ? "deposit" : l.topics[0] === WITHDRAWN ? "withdraw" : "claim",
        who: ethers.getAddress("0x" + l.topics[1]!.slice(26)),
        t: blk!.timestamp,
        tx: l.transactionHash,
      });
    }
  }
  logs.sort((a, b) => a.t - b.t);
  console.log(`balance-changing events since deploy: ${logs.length}`);

  const n = Number(await pool.drawCount!());
  const draws: { id: number; periodStart: number; snapshotAt: number; totalWeight: bigint; revealed: boolean }[] = [];
  for (let id = 1; id <= n; id++) {
    const d = await pool.drawAt!(id);
    draws.push({
      id,
      periodStart: Number(d.periodStart),
      snapshotAt: Number(d.snapshotAt),
      totalWeight: d.totalWeight,
      revealed: Number(d.status) === 2,
    });
  }

  console.log("\n=== windows containing exactly one balance-changing event ===\n");
  const solved: Record<string, unknown>[] = [];

  for (const d of draws) {
    if (!d.revealed || d.totalWeight === 0n) continue;
    const window = d.snapshotAt - d.periodStart;
    if (window <= 0) continue;

    const inWindow = logs.filter((l) => l.t > d.periodStart && l.t <= d.snapshotAt);
    if (inWindow.length !== 1) continue;

    // The previous revealed draw gives the balance carried into this window.
    const prev = draws.filter((x) => x.id < d.id && x.revealed && x.totalWeight > 0n).pop();
    if (prev === undefined) continue;
    const prevWindow = prev.snapshotAt - prev.periodStart;
    if (prevWindow <= 0) continue;
    const prevBalance = prev.totalWeight / BigInt(prevWindow);

    const e = inWindow[0]!;
    const after = BigInt(d.snapshotAt - e.t);
    if (after === 0n) continue;

    // totalWeight = prevBalance*window + delta*after   ->   solve for delta
    const base = prevBalance * BigInt(window);
    const residual = d.totalWeight - base;
    const delta = residual / after;

    console.log(
      `draw ${d.id}: window ${window}s, one ${e.kind} by ${e.who.slice(0, 10)}… at +${e.t - d.periodStart}s\n` +
        `  carried-in balance : ${Number(prevBalance) / 1e6} cUSDC   (from draw ${prev.id})\n` +
        `  totalWeight        : ${d.totalWeight}\n` +
        `  base if unchanged  : ${base}\n` +
        `  residual           : ${residual}\n` +
        `  SOLVED ${e.kind}   : ${Number(delta) / 1e6} cUSDC   (exact: ${residual % after === 0n})\n` +
        `  tx                 : ${e.tx}\n`,
    );
    solved.push({
      draw: d.id,
      kind: e.kind,
      who: e.who,
      tx: e.tx,
      recovered: delta.toString(),
      recoveredHuman: Number(delta) / 1e6,
      exact: residual % after === 0n,
    });
  }

  if (solved.length === 0) {
    console.log("  none — every window carried zero or several events in this history.");
    console.log("  That does not refute X1; it means this particular history does not");
    console.log("  contain the case. The arithmetic is unchanged.");
  }

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/x1-window-solve.json", JSON.stringify({ at: new Date().toISOString(), events: logs.length, solved }, null, 2));
  console.log(`\nwrote out/x1-window-solve.json — ${solved.length} window(s) solved`);
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
