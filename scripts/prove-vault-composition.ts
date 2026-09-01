import { ethers, fhevm } from "hardhat";
const SRC = "0x15331b79E80EF6606a1aD4C0b13F7EA49482e8A5";
const SHARE = "0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4";
const BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b";

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
