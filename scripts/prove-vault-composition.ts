import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Read at RUN time, not baked in at edit time.
 *
 * A previous pass claimed to have done this and had not: the substitution
 * replaced the address VALUE, so the constant was still a literal and the script
 * kept pointing at the source from the deployment before last. It joined a batch
 * for a contract that no longer holds anything of the pool's — which is the exact
 * failure the change was supposed to prevent, committed with a message saying it
 * had been prevented.
 */
const deployment = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "out", "deployment.json"), "utf8"),
) as { yieldSource: string; vaultShare: string; depositBatcher: string };

const SRC = process.env.SRC ?? deployment.yieldSource;
const SHARE = deployment.vaultShare;
const BATCHER = deployment.depositBatcher;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC, s!);
  const share = new ethers.Contract(SHARE, ["function confidentialBalanceOf(address) view returns (bytes32)"], s!);
  const batcher = new ethers.Contract(BATCHER, ["function currentBatchId() view returns (uint256)"], s!);

  const p: string = await src.principal!();
  console.log(`principal handle ${p.slice(0, 20)}…  type-byte 0x${p.slice(-4, -2)} (05 = euint64)`);
  const before: string = await share.confidentialBalanceOf!(SRC);
  console.log(`batch id now     ${await batcher.currentBatchId!()}`);
  console.log(`shares before    ${before === ethers.ZeroHash ? "none" : before.slice(0, 20) + "…"}`);

  console.log(`\njoinVault() — half the principal into Zama's batcher`);
  const tx = await src.joinVault!();
  const rc = await tx.wait();
  console.log(`  ${tx.hash}`);
  console.log(`  gas ${rc!.gasUsed}   logs ${rc!.logs.length}`);
  for (const l of rc!.logs) {
    if (l.address.toLowerCase() === BATCHER.toLowerCase()) console.log(`  the batcher emitted ${l.topics[0]!.slice(0, 12)}… — it saw the transfer`);
  }
  const batches = await src.openBatches!();
  console.log(`  open batches: [${batches.join(", ")}]`);
  const after: string = await share.confidentialBalanceOf!(SRC);
  console.log(`  shares after  ${after === ethers.ZeroHash ? "none yet — settles on Zama's keeper" : after.slice(0, 20) + "…"}`);
}
main().catch((e) => { console.error(String(e).split("\n").slice(0, 4).join("\n")); process.exitCode = 1; });
