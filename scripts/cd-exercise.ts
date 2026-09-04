/**
 * CD — exercising the four new claims on chain.
 *
 * None of these had a live transaction behind them, and a claim with no
 * transaction is the thing this project has spent a week removing.
 *
 *   npx hardhat run scripts/cd-exercise.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const TOKEN = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";

async function main() {
  await fhevm.initializeCLIApi();
  const [me] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  const token = await ethers.getContractAt("ERC7984Mock", TOKEN);
  const out: Record<string, unknown> = { pool: POOL, at: new Date().toISOString() };

  const id = Number(await pool.drawCount());
  console.log(`draw ${id}`);

  // ---- reveal -----------------------------------------------------------
  let d = await pool.drawAt(id);
  if (Number(d.status) === 1) {
    const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
    const r = await (await pool.revealDraw(id, pub.abiEncodedClearValues, pub.decryptionProof)).wait();
    console.log(`  revealed  ${r!.hash}  ${r!.gasUsed} gas`);
    out.revealTx = r!.hash;
    out.revealGas = String(r!.gasUsed);
  }
  d = await pool.drawAt(id);
  console.log(`  r ${d.r}   totalWeight ${d.totalWeight}`);

  // ---- 1. the solvency bit ----------------------------------------------
  console.log(`\n1. solventAt(${id}) — is the reserve able to cover SOLVENCY_COVER grand prizes?`);
  const handle = await pool.solventAt(id);
  const dec = await fhevm.publicDecrypt([handle]);
  const value = Object.values(dec.clearValues ?? dec)[0];
  const reserveCover = 4n * 25_000_000n;
  console.log(`   handle   ${handle}`);
  console.log(`   decrypts to  ${value}`);
  console.log(`   claim: reserve >= ${Number(reserveCover) / 1e6} cUSDC`);
  out.solventHandle = handle;
  out.solventValue = String(value);

  // ---- 2. accrueMany twice, fee paid once -------------------------------
  console.log(`\n2. accrueMany twice on the same address — the fee must be paid once`);
  const bal = async () => {
    const h = await token.confidentialBalanceOf(me!.address);
    return h === ethers.ZeroHash ? 0n : ((await fhevm.userDecryptEuint(FhevmType.euint64, h, TOKEN, me!)) as bigint);
  };
  const before = await bal();
  const a1 = await (await pool.accrueMany([me!.address], id)).wait();
  const mid = await bal();
  const a2 = await (await pool.accrueMany([me!.address], id)).wait();
  const after = await bal();
  console.log(`   first   ${a1!.hash}   +${mid - before}`);
  console.log(`   second  ${a2!.hash}   +${after - mid}   <- must be 0`);
  out.accrueFirstTx = a1!.hash;
  out.accrueSecondTx = a2!.hash;
  out.feeFirst = String(mid - before);
  out.feeSecond = String(after - mid);

  // ---- 3. the keeper liveness reward -------------------------------------
  console.log(`\n3. liveness reward — LivenessPaid events on this pool`);
  const logs = await ethers.provider.getLogs({
    address: POOL,
    topics: [ethers.id("LivenessPaid(address,uint64)")],
    fromBlock: (await ethers.provider.getBlockNumber()) - 9000,
  });
  console.log(`   ${logs.length} LivenessPaid event(s)`);
  for (const l of logs) console.log(`   ${l.transactionHash}  amount ${BigInt(l.data)}`);
  out.livenessEvents = logs.length;
  out.livenessTxs = logs.map((l) => l.transactionHash);

  // ---- 4. withdraw(max) --------------------------------------------------
  console.log(`\n4. withdraw(type(uint64).max) — the full exit that was impossible before (d)`);
  const posBefore = await pool.confidentialBalanceOf(me!.address);
  const vBefore = posBefore === ethers.ZeroHash ? 0n : ((await fhevm.userDecryptEuint(FhevmType.euint64, posBefore, POOL, me!)) as bigint);
  console.log(`   position before  ${Number(vBefore) / 1e6} cUSDC`);
  const MAX = (1n << 64n) - 1n;
  const enc = await fhevm.createEncryptedInput(POOL, me!.address).add64(MAX).encrypt();
  const wtx = await (await pool.withdraw(enc.handles[0], enc.inputProof)).wait();
  const posAfter = await pool.confidentialBalanceOf(me!.address);
  const vAfter = posAfter === ethers.ZeroHash ? 0n : ((await fhevm.userDecryptEuint(FhevmType.euint64, posAfter, POOL, me!)) as bigint);
  console.log(`   ${wtx!.hash}  ${wtx!.gasUsed} gas`);
  console.log(`   position after   ${Number(vAfter) / 1e6} cUSDC   <- must be 0`);
  out.withdrawMaxTx = wtx!.hash;
  out.positionBefore = String(vBefore);
  out.positionAfter = String(vAfter);

  fs.writeFileSync("out/cd-exercise.json", JSON.stringify(out, null, 2));
  console.log(`\nwritten to out/cd-exercise.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
