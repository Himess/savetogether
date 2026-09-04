/**
 * F3 — the cycle from an unprivileged wallet.
 *
 * D1 ran as the deployer, which is also the pool owner and the keeper. Every
 * function it touched is permissionless in the source, so no privileged path was
 * taken — but that is an argument, and the point of a live run is to replace
 * arguments with hashes.
 *
 * This generates a fresh key that has never touched the pool, funds it with gas
 * and cUSDC and nothing else, and runs deposit -> draw -> claim -> withdraw from
 * it. The fresh key is never the owner, never the keeper, and holds no role.
 *
 * The draw is opened by the DEPLOYER, not by the fresh wallet, so that the fresh
 * wallet's four transactions are exactly the four a depositor sends.
 *
 *   npx hardhat run scripts/f3-fresh-wallet.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { ContractTransactionResponse, Signer, TransactionResponse } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";

const GAS_FUND = ethers.parseEther("0.05");
const CUSDC_FUND = 300_000_000n; // 300 cUSDC
const DEPOSIT = 200_000_000n; // 200 cUSDC
const WITHDRAW = 120_000_000n; // 120 cUSDC

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [deployer] = await ethers.getSigners();
  const funder = deployer!;
  const funderAddr = await funder.getAddress();

  // A key that has never existed before this run.
  const fresh = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`funder (deployer/owner/keeper): ${funderAddr}`);
  console.log(`FRESH WALLET:                   ${fresh.address}`);
  console.log(`  nonce ${await ethers.provider.getTransactionCount(fresh.address)}, ` +
    `balance ${ethers.formatEther(await ethers.provider.getBalance(fresh.address))} ETH\n`);

  const hashes: Record<string, string> = {};
  const rec = async (name: string, p: Promise<ContractTransactionResponse | TransactionResponse>): Promise<void> => {
    const t = await p;
    const r = await t.wait();
    hashes[name] = t.hash;
    console.log(`  ${name.padEnd(22)} ${t.hash}  gas ${r!.gasUsed}`);
  };

  const poolAsFunder = await ethers.getContractAt("ConfidentialPrizePool", POOL, funder);
  const tokenAsFunder = await ethers.getContractAt("IERC7984", CUSDC, funder);
  const poolAsFresh = await ethers.getContractAt("ConfidentialPrizePool", POOL, fresh);
  const tokenAsFresh = await ethers.getContractAt("IERC7984", CUSDC, fresh);

  const decAs = async (h: string, at: string, who: Signer): Promise<bigint | null> => {
    if (!h || h === ethers.ZeroHash) return 0n;
    try { return (await fhevm.userDecryptEuint(FhevmType.euint64, h, at, who)) as bigint; }
    catch { return null; }
  };
  const f6 = (v: bigint | null): string => (v === null ? "UNREADABLE" : String(Number(v) / 1e6));

  // ------------------------------------------------------------------ funding
  console.log("--- funding the fresh wallet (gas + cUSDC, nothing else) ---");
  await rec("fund gas", funder.sendTransaction({ to: fresh.address, value: GAS_FUND }));
  {
    const input = fhevm.createEncryptedInput(CUSDC, funderAddr);
    input.add64(CUSDC_FUND);
    const enc = await input.encrypt();
    await rec(
      "fund cUSDC",
      tokenAsFunder["confidentialTransfer(address,bytes32,bytes)"]!(
        fresh.address,
        ethers.hexlify(enc.handles[0]!),
        ethers.hexlify(enc.inputProof),
      ),
    );
  }
  console.log(`  fresh cUSDC: ${f6(await decAs(await tokenAsFresh.confidentialBalanceOf!(fresh.address), CUSDC, fresh))}`);
  console.log(`  fresh ETH:   ${ethers.formatEther(await ethers.provider.getBalance(fresh.address))}`);
  console.log(`  is fresh the owner? ${(await poolAsFunder.owner!()).toLowerCase() === fresh.address.toLowerCase()}`);

  // -------------------------------------------------- the depositor's four txs
  console.log("\n--- the four transactions a depositor actually sends ---");
  await rec("1. setOperator(pool)", tokenAsFresh.setOperator!(POOL, Math.floor(Date.now() / 1000) + 365 * 24 * 3600));

  {
    const input = fhevm.createEncryptedInput(POOL, fresh.address);
    input.add64(DEPOSIT);
    const enc = await input.encrypt();
    await rec("2. deposit 200 cUSDC", poolAsFresh.deposit!(ethers.hexlify(enc.handles[0]!), ethers.hexlify(enc.inputProof)));
  }
  const posAfterDeposit = await decAs(await poolAsFresh.confidentialBalanceOf!(fresh.address), POOL, fresh);
  console.log(`  fresh position: ${f6(posAfterDeposit)} cUSDC`);

  // The draw is driven by the deployer — a depositor does not open draws.
  console.log("\n--- a draw runs (opened by the keeper, not by the fresh wallet) ---");
  const minPeriod = Number(await poolAsFunder.minPeriod!());
  const prev = await poolAsFunder.drawAt!(Number(await poolAsFunder.drawCount!()));
  const wait = Number(prev.snapshotAt) + minPeriod - Math.floor(Date.now() / 1000) + 15;
  if (wait > 0) {
    console.log(`  waiting ${wait}s for minPeriod`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  await rec("   harvest (keeper)", poolAsFunder.harvest!());
  await rec("   openDraw (keeper)", poolAsFunder.openDraw!());
  const drawId = Number(await poolAsFunder.drawCount!());
  const d = await poolAsFunder.drawAt!(drawId);
  const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
  await rec("   revealDraw (keeper)", poolAsFunder.revealDraw!(drawId, pub.abiEncodedClearValues, pub.decryptionProof));

  // Accrual is permissionless: the fresh wallet accrues ITSELF.
  await rec("3. accrue(self)", poolAsFresh.accrue!(fresh.address, drawId));
  const winAfter = await decAs(await poolAsFresh.winningsOf!(fresh.address), POOL, fresh);
  const posAfterAccrue = await decAs(await poolAsFresh.confidentialBalanceOf!(fresh.address), POOL, fresh);
  const th = await poolAsFunder["thresholdFor(uint32,address,uint8)"]!(drawId, fresh.address, 2);
  console.log(`  draw ${drawId}: totalWeight=${d.encTotalWeight ? (await poolAsFunder.drawAt!(drawId)).totalWeight : "?"} ordinaryThreshold=${th}`);
  console.log(`  fresh winnings: ${f6(winAfter)} cUSDC   position: ${f6(posAfterAccrue)}`);

  await rec("4. claim(self)", poolAsFresh.claim!(fresh.address));
  const posAfterClaim = await decAs(await poolAsFresh.confidentialBalanceOf!(fresh.address), POOL, fresh);
  console.log(`  position after claim: ${f6(posAfterClaim)} cUSDC`);

  {
    const input = fhevm.createEncryptedInput(POOL, fresh.address);
    input.add64(WITHDRAW);
    const enc = await input.encrypt();
    await rec("5. withdraw 120 cUSDC", poolAsFresh.withdraw!(ethers.hexlify(enc.handles[0]!), ethers.hexlify(enc.inputProof)));
  }
  const posEnd = await decAs(await poolAsFresh.confidentialBalanceOf!(fresh.address), POOL, fresh);
  const walEnd = await decAs(await tokenAsFresh.confidentialBalanceOf!(fresh.address), CUSDC, fresh);
  console.log(`  position: ${f6(posEnd)} cUSDC   wallet: ${f6(walEnd)} cUSDC`);

  // ------------------------------------------------- the under-grant, from here
  console.log("\n--- F1 check from an account that has never been special ---");
  const pend = await decAs(await poolAsFresh.pendingOf!(fresh.address), POOL, fresh);
  console.log(`  pendingOf(self): ${pend === null ? "NOT READABLE — under-grant confirmed from a fresh key" : f6(pend)}`);

  console.log("\n=============== F3 RESULT ===============");
  console.log(`fresh wallet ${fresh.address} — never the owner, never the keeper`);
  for (const [k, v] of Object.entries(hashes)) console.log(`  ${k.padEnd(22)} ${v}`);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/f3-fresh-wallet.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        freshWallet: fresh.address,
        // The key is ephemeral and holds only leftover testnet dust after this run.
        funder: funderAddr,
        drawId,
        hashes,
        positionAfterDeposit: posAfterDeposit?.toString() ?? null,
        winningsAfterAccrue: winAfter?.toString() ?? null,
        positionAfterClaim: posAfterClaim?.toString() ?? null,
        positionEnd: posEnd?.toString() ?? null,
        walletEnd: walEnd?.toString() ?? null,
        pendingReadableByOwner: pend !== null,
      },
      null,
      2,
    ),
  );
  console.log("\nwrote out/f3-fresh-wallet.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 5).join("\n"));
  process.exitCode = 1;
});
