/**
 * EE — checking the derivation against the chain, not against the UI.
 *
 * The screen now prints an aggregate balance it DERIVES: `totalWeight / window`.
 * A derived figure that nothing independently reproduces is the same shape of
 * claim this project spent a week removing, so this recomputes it from the raw
 * draw record and counts the depositors the same way the browser does.
 *
 *   npx hardhat run scripts/ee-check-pool-size.ts --network sepolia
 */
import { ethers } from "hardhat";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const FROM = 11_600_000;

async function main() {
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  const count = Number(await pool.drawCount());
  console.log(`drawCount ${count}`);

  // The most recent draw that actually published an aggregate. status 2 =
  // Revealed; an Open draw has totalWeight 0 and would divide to nothing.
  let picked: { id: number; total: bigint; window: number } | null = null;
  for (let id = count; id >= Math.max(1, count - 7); id--) {
    const d = await pool.drawAt(id);
    const status = Number(d.status);
    const window = Number(d.snapshotAt) - Number(d.periodStart);
    console.log(
      `  #${String(id).padStart(2)}  status ${status}  window ${String(window).padStart(6)}s  totalWeight ${d.totalWeight}`,
    );
    if (picked === null && status === 2 && d.totalWeight > 0n && window > 0) {
      picked = { id, total: d.totalWeight, window };
    }
  }
  if (picked === null) throw new Error("no revealed draw with an aggregate");

  // balance-seconds / seconds = balance, in base units. 6 decimals.
  const avg = Number(picked.total) / picked.window;
  console.log(`\npicked draw #${picked.id}`);
  console.log(`  totalWeight  ${picked.total}`);
  console.log(`  window       ${picked.window}s`);
  console.log(`  derived      ${(avg / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} cUSDC`);
  console.log(`  (this is the WINDOW AVERAGE, not the balance right now)`);

  // Distinct addresses that have ever deposited. Same source the browser uses:
  // the indexed `user` topic on Deposited, nothing else read.
  const provider = ethers.provider;
  const head = await provider.getBlockNumber();
  const topic = ethers.id("Deposited(address,uint40,uint256)");
  const seen = new Set<string>();
  for (let f = FROM; f <= head; f += 9_000) {
    const to = Math.min(f + 8_999, head);
    const logs = await provider.getLogs({ address: POOL, fromBlock: f, toBlock: to, topics: [topic] });
    for (const l of logs) if (l.topics[1]) seen.add("0x" + l.topics[1].slice(26).toLowerCase());
  }
  console.log(`\ndepositors (ever)  ${seen.size}`);
  console.log(`  blocks ${FROM}..${head}`);
  for (const a of seen) console.log(`    ${a}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
