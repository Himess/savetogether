/**
 * D1 pre-flight.
 *
 * Reads and decrypts everything the full-cycle run depends on, before any
 * transaction is sent. Nothing here writes.
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";
const SRC = "0xDa596e47029839eA7E1990f97F106fd6d2e33695";
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const U = 1_000_000n;

const fmt = (v: bigint): string => `${Number(v) / 1e6} cUSDC (${v})`;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  console.log("signer      ", me);
  console.log("ETH         ", ethers.formatEther(await ethers.provider.getBalance(me)));

  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);
  const token = await ethers.getContractAt("IERC7984", CUSDC, s!);

  const dec = async (h: string, c: string, label: string): Promise<bigint | null> => {
    if (!h || h === ethers.ZeroHash) {
      console.log(`${label.padEnd(26)} uninitialised (zero handle)`);
      return null;
    }
    try {
      const v = (await fhevm.userDecryptEuint(FhevmType.euint64, h, c, s!)) as bigint;
      console.log(`${label.padEnd(26)} ${fmt(v)}`);
      return v;
    } catch (e) {
      console.log(`${label.padEnd(26)} NOT READABLE BY ME — ${String(e).split("\n")[0]!.slice(0, 70)}`);
      return null;
    }
  };

  console.log("\n--- my state in the pool ---");
  const position = await dec(await pool.confidentialBalanceOf!(me), POOL, "position");
  const pending = await dec(await pool.pendingOf!(me), POOL, "pending (claimable)");
  const winnings = await dec(await pool.winningsOf!(me), POOL, "winnings (lifetime)");

  console.log("\n--- my wallet ---");
  const walletC = await dec(await token.confidentialBalanceOf!(me), CUSDC, "cUSDC in wallet");
  const erc20 = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], s!);
  console.log("USDC in wallet            ", fmt(await erc20.balanceOf!(me)));

  console.log("\n--- the pool's withdrawal buffer (source's liquid cUSDC) ---");
  await dec(await token.confidentialBalanceOf!(SRC), CUSDC, "source cUSDC (buffer)");
  await dec(await token.confidentialBalanceOf!(POOL), CUSDC, "pool cUSDC");

  console.log("\n--- draw state ---");
  const n = Number(await pool.drawCount!());
  console.log("drawCount                 ", n);
  const d = await pool.drawAt!(n);
  const status = ["None", "Open", "Revealed", "Cancelled"][Number(d.status)] ?? String(d.status);
  console.log(`draw ${n}                    status=${status} periodStart=${d.periodStart} snapshotAt=${d.snapshotAt} r=${d.r} totalWeight=${d.totalWeight}`);
  const minPeriod = await pool.minPeriod!();
  const now = Math.floor(Date.now() / 1000);
  const earliest = Number(d.snapshotAt) + Number(minPeriod);
  console.log("minPeriod                 ", String(minPeriod), "s");
  console.log("next openDraw allowed at  ", new Date(earliest * 1000).toISOString(), earliest <= now ? "(NOW)" : `(in ${earliest - now}s)`);
  console.log("accrued[draw][me]         ", await pool.accrued!(n, me));

  console.log("\n--- operator status (deposit needs the pool to be my operator) ---");
  const isOp = await token.isOperator!(me, POOL);
  console.log("pool is my operator       ", isOp);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/d1-preflight.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        me,
        position: position?.toString() ?? null,
        pending: pending?.toString() ?? null,
        winnings: winnings?.toString() ?? null,
        walletCUSDC: walletC?.toString() ?? null,
        drawCount: n,
        drawStatus: status,
        nextOpenDrawAt: earliest,
        poolIsOperator: isOp,
      },
      null,
      2,
    ),
  );
  console.log("\nwrote out/d1-preflight.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 3).join("\n"));
  process.exitCode = 1;
});
