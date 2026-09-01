import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
const POOL = "0x1d8A0d653027833E4e8eA4DE67B90512Aad7B85f";
const SRC = "0x15331b79E80EF6606a1aD4C0b13F7EA49482e8A5";
const U = 1_000_000n;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);
  const dec = async (h: string, c: string): Promise<string> => {
    if (h === ethers.ZeroHash) return "0 (uninitialised)";
    try { return `${await fhevm.userDecryptEuint(FhevmType.euint64, h, c, s!) as bigint}`; }
    catch (e) { return `not readable by me (${String(e).slice(0, 40)}…)`; }
  };
  console.log("draws        ", await pool.drawCount!());
  console.log("prize        ", (await pool.prize!()) / U, "cUSDC");
  console.log("yieldSource  ", await pool.yieldSource!());
  console.log("my position  ", await dec(await pool.confidentialBalanceOf!(me), POOL));
  console.log("my winnings  ", await dec(await pool.winningsOf!(me), POOL));
  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC, s!);
  console.log("open batches ", (await src.openBatches!()).join(", ") || "none");
  console.log("lastAccrual  ", new Date(Number(await src.lastAccrual!()) * 1000).toISOString());
}
main().catch((e) => { console.error(String(e).split("\n")[0]); process.exitCode = 1; });
