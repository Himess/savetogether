/**
 * The README's join tx was a generation behind and the address check could not
 * see it, because a tx hash is not an address. So: find the real one on chain,
 * from the live source's own event, and print what the README must say.
 */
import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const d = JSON.parse(fs.readFileSync("out/deployment.json", "utf8"));
  const src = await ethers.getContractAt("SteakhouseReplicaSource", d.yieldSource);
  const latest = await ethers.provider.getBlockNumber();

  for (const name of ["JoinedVault", "ClaimedShares"]) {
    const logs = await src.queryFilter(src.filters[name]!(), d.block, latest);
    console.log(`\n${name}: ${logs.length}`);
    for (const l of logs) {
      console.log(`  batch ${l.args![0]}  block ${l.blockNumber}  tx ${l.transactionHash}`);
    }
  }
}
main().catch((e) => { console.error(String(e).split("\n").slice(0, 3).join("\n")); process.exitCode = 1; });
