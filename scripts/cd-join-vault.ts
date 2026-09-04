/**
 * The new source has to join Zama's vault, or the composition claim is stale.
 *
 * `joinVault` is per-source, and a redeploy of `SteakhouseReplicaSource` starts
 * with `inVault = 0` and no shares. Batch 286 belongs to the previous source and
 * proves nothing about this one, so the strongest artifact in the repo has to be
 * re-earned rather than re-cited.
 */
import { ethers } from "hardhat";
import * as fs from "fs";

const SRC = "0xB16EB979231A95C2Ad454Ebd456b4c5AD23811Ba";

async function main() {
  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC);
  console.log(`source ${SRC}`);
  console.log(`inVault before: ${await src.inVault()}`);

  const tx = await (await src.joinVault()).wait();
  console.log(`joinVault  ${tx!.hash}  ${tx!.gasUsed} gas`);

  const ev = tx!.logs
    .map((l) => { try { return src.interface.parseLog(l as never); } catch { return null; } })
    .find((e) => e && /Join|Vault|Batch/i.test(e.name));
  const batchId = ev?.args?.[0] ?? ev?.args?.batchId;
  console.log(`event: ${ev?.name ?? "(none decoded)"}   batch ${batchId ?? "?"}`);

  console.log(`inVault after:  ${await src.inVault()}`);
  fs.writeFileSync("out/cd-join-vault.json", JSON.stringify({
    source: SRC, tx: tx!.hash, gas: String(tx!.gasUsed),
    batchId: batchId === undefined ? null : String(batchId),
    at: new Date().toISOString(),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
