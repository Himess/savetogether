import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";
const SRC = "0xDa596e47029839eA7E1990f97F106fd6d2e33695";
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
  console.log("tiers        ", [0,1,2].map(async()=>0) && (await Promise.all([0,1,2].map((i)=>pool.tierPrize!(i)))).map((x)=>Number(x)/1e6).join(" / "), "cUSDC");
  console.log("yieldSource  ", await pool.yieldSource!());
  console.log("my position  ", await dec(await pool.confidentialBalanceOf!(me), POOL));
  console.log("my winnings  ", await dec(await pool.winningsOf!(me), POOL));
  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC, s!);
  console.log("open batches ", (await src.openBatches!()).join(", ") || "none");
  console.log("lastAccrual  ", new Date(Number(await src.lastAccrual!()) * 1000).toISOString());
}
main().catch((e) => { console.error(String(e).split("\n")[0]); process.exitCode = 1; });
