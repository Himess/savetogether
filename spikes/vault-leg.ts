/**
 * Where is the pool's principal right now, in Zama's own batcher? JoinedVault
 * fired for batch 286 but ClaimedShares never did, so either the batch has not
 * settled yet or we owe it a claim.
 */
import { ethers } from "hardhat";
import * as fs from "fs";

const BATCHER = [
  "function currentBatchId() view returns (uint256)",
  "function lastSettledBatchId() view returns (uint256)",
  "function isBatchSettled(uint256) view returns (bool)",
];

async function main() {
  const d = JSON.parse(fs.readFileSync("out/deployment.json", "utf8"));
  const src = await ethers.getContractAt("SteakhouseReplicaSource", d.yieldSource);

  console.log("source state");
  for (const fn of ["inVault", "pendingBatch", "principal", "stage"]) {
    try { console.log(`  ${fn.padEnd(14)} ${await (src as any)[fn]()}`); } catch (e) { console.log(`  ${fn.padEnd(14)} (no such view)`); }
  }

  const b = new ethers.Contract(d.depositBatcher, BATCHER, ethers.provider);
  for (const fn of ["currentBatchId", "lastSettledBatchId"]) {
    try { console.log(`  ${fn.padEnd(14)} ${await (b as any)[fn]()}`); } catch { console.log(`  ${fn.padEnd(14)} (no such view)`); }
  }
  try { console.log(`  286 settled?   ${await (b as any).isBatchSettled(286)}`); } catch { console.log("  286 settled?   (no such view)"); }

  const share = new ethers.Contract(d.vaultShare, ["function confidentialBalanceOf(address) view returns (bytes32)"], ethers.provider);
  console.log(`  share handle   ${await share.confidentialBalanceOf!(d.yieldSource)}`);
}
main().catch((e) => { console.error(String(e).split("\n").slice(0, 3).join("\n")); process.exitCode = 1; });
