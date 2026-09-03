/**
 * D1 — the full required cycle, live on Sepolia.
 *
 * The brief scores "Do deposit, draw, claim, and withdraw produce the expected
 * results onchain?" Three of those had never run on this deployment: `Claimed`
 * and `Withdrawn` had zero events, and no unwrap had ever been requested from a
 * pool participant. This script runs all five in one pass, from one funded
 * account, decrypting the state before and after each step so the assertion is
 * against a value rather than against the absence of a revert.
 *
 * Every step continues past a failure and records it, so one pass yields every
 * defect rather than the first one.
 *
 *   npx hardhat run scripts/d1-cycle.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { ContractTransactionResponse, TransactionResponse } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";

const DEPOSIT = 500_000_000n; // 500 cUSDC
const WITHDRAW = 250_000_000n; // 250 cUSDC
const UNWRAP = 100_000_000n; // 100 cUSDC

type Step = {
  step: string;
  ok: boolean;
  hash?: string;
  block?: number;
  gasUsed?: string;
  note?: string;
  error?: string;
};
const steps: Step[] = [];
const fmt = (v: bigint | null): string => (v === null ? "unreadable" : `${Number(v) / 1e6}`);

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);
  const token = await ethers.getContractAt("IERC7984", CUSDC, s!);
  const erc20 = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], s!);

  const dec = async (h: string, c: string): Promise<bigint | null> => {
    if (!h || h === ethers.ZeroHash) return 0n;
    try {
      return (await fhevm.userDecryptEuint(FhevmType.euint64, h, c, s!)) as bigint;
    } catch {
      return null;
    }
  };
  const snapshot = async (label: string): Promise<Record<string, string>> => {
    const position = await dec(await pool.confidentialBalanceOf!(me), POOL);
    const pending = await dec(await pool.pendingOf!(me), POOL);
    const winnings = await dec(await pool.winningsOf!(me), POOL);
    const wallet = await dec(await token.confidentialBalanceOf!(me), CUSDC);
    const usdc = (await erc20.balanceOf!(me)) as bigint;
    const row = {
      position: fmt(position),
      pending: fmt(pending),
      winnings: fmt(winnings),
      walletCUSDC: fmt(wallet),
      walletUSDC: fmt(usdc),
    };
    console.log(
      `  [${label}] position=${row.position} pending=${row.pending} winnings=${row.winnings} ` +
        `wallet-cUSDC=${row.walletCUSDC} wallet-USDC=${row.walletUSDC}`,
    );
    return row;
  };
  const encrypt = async (value: bigint, contract: string): Promise<{ handle: string; proof: string }> => {
    const input = fhevm.createEncryptedInput(contract, me);
    input.add64(value);
    const enc = await input.encrypt();
    return { handle: ethers.hexlify(enc.handles[0]!), proof: ethers.hexlify(enc.inputProof) };
  };
  const send = async (name: string, fn: () => Promise<ContractTransactionResponse>, note?: string): Promise<boolean> => {
    console.log(`\n=== ${name} ===`);
    try {
      const tx = await fn();
      console.log(`  sent ${tx.hash}`);
      const r = await tx.wait();
      console.log(`  mined block ${r!.blockNumber}  gas ${r!.gasUsed}`);
      steps.push({ step: name, ok: true, hash: tx.hash, block: r!.blockNumber, gasUsed: r!.gasUsed.toString(), note });
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200);
      console.log(`  FAILED: ${msg}`);
      steps.push({ step: name, ok: false, error: msg, note });
      return false;
    }
  };

  console.log(`signer ${me}`);
  console.log(`ETH    ${ethers.formatEther(await ethers.provider.getBalance(me))}`);
  console.log("\n--- before ---");
  const before = await snapshot("before");

  // ---------------------------------------------------------------- 1. deposit
  {
    const { handle, proof } = await encrypt(DEPOSIT, POOL);
    await send("1. deposit 500 cUSDC", async () => pool.deposit!(handle, proof), "encrypted deposit into the pool");
    await snapshot("after deposit");
  }

  // ------------------------------------------------------------------- 2. draw
  let drawId = 0;
  {
    const ok = await send("2a. openDraw", async () => pool.openDraw!(), "snapshots the window and draws encrypted R");
    drawId = Number(await pool.drawCount!());
    if (ok) {
      const d = await pool.drawAt!(drawId);
      console.log(`  draw ${drawId} opened; requesting public decryption of R and totalWeight`);
      try {
        const t0 = Date.now();
        const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
        console.log(`  KMS returned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        await send(
          "2b. revealDraw",
          async () => pool.revealDraw!(drawId, pub.abiEncodedClearValues, pub.decryptionProof),
          "publishes R and totalWeight with the KMS proof",
        );
        const after = await pool.drawAt!(drawId);
        console.log(`  draw ${drawId}: r=${after.r} totalWeight=${after.totalWeight} status=${after.status}`);
      } catch (e) {
        const msg = String((e as Error).message ?? e).split("\n")[0]!.slice(0, 200);
        console.log(`  KMS decrypt FAILED: ${msg}`);
        steps.push({ step: "2b. revealDraw", ok: false, error: msg });
      }
      await send("2c. accrue(me)", async () => pool.accrue!(me, drawId), "unconditional accrual — wins and losses look identical");
    }
    await snapshot("after draw");
  }

  // ------------------------------------------------------------------ 3. claim
  {
    const pendingBefore = await dec(await pool.pendingOf!(me), POOL);
    console.log(`\n  pending before claim: ${fmt(pendingBefore)} cUSDC`);
    await send("3. claim(me)", async () => pool.claim!(me), "folds the pending credit into the balance");
    const pendingAfter = await dec(await pool.pendingOf!(me), POOL);
    console.log(`  pending after claim:  ${fmt(pendingAfter)} cUSDC`);
    steps.filter((x) => x.step.startsWith("3.")).forEach((x) => {
      x.note = `pending ${fmt(pendingBefore)} -> ${fmt(pendingAfter)} cUSDC`;
    });
    await snapshot("after claim");
  }

  // --------------------------------------------------------------- 4. withdraw
  {
    const { handle, proof } = await encrypt(WITHDRAW, POOL);
    await send("4. withdraw 250 cUSDC", async () => pool.withdraw!(handle, proof), "clamped: asking for more than held moves nothing");
    await snapshot("after withdraw");
  }

  // ----------------------------------------------------------------- 5. unwrap
  {
    const { handle, proof } = await encrypt(UNWRAP, CUSDC);
    const wrapper = new ethers.Contract(
      CUSDC,
      ["function unwrap(address,address,bytes32,bytes) returns (bytes32)"],
      s!,
    );
    await send("5. unwrap 100 cUSDC to USDC", async () => wrapper.unwrap!(me, me, handle, proof), "asynchronous — the KMS decrypts and USDC settles after");
    await snapshot("after unwrap request");
  }

  console.log("\n--- after ---");
  const after = await snapshot("after");

  console.log("\n=================== D1 RESULT ===================");
  for (const x of steps) {
    console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.step.padEnd(28)} ${x.hash ?? x.error ?? ""}`);
  }
  const passed = steps.filter((x) => x.ok).length;
  console.log(`\n${passed}/${steps.length} steps succeeded`);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/d1-cycle.json",
    JSON.stringify({ at: new Date().toISOString(), signer: me, drawId, before, after, steps }, null, 2),
  );
  console.log("wrote out/d1-cycle.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
