/**
 * Seeds the demo pool and runs one complete round on chain.
 *
 * This is the choreography decided in findings.md §11.5: six participants, so
 * accrual fits in a single transaction and the whole round — open, reveal,
 * credit, balances move — can be shown without a cut. Cutting between shots is
 * allowed in the video; speeding up is not, so the round has to actually be short.
 *
 * It also serves as the end-to-end check the day-4 plan wanted: the real
 * `ConfidentialPrizePool`, the real KMS reveal, and `accrueMany` over everyone.
 *
 *   POOL=0x... npx hardhat run scripts/demo-round.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import type { Contract } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";
import * as path from "path";

const PARTICIPANTS = Number(process.env.PARTICIPANTS ?? 6);
const OUT = path.join(__dirname, "..", "out");

function loadDeployment(): { pool: string; token: string } {
  const f = path.join(OUT, "deployment.json");
  if (!fs.existsSync(f)) throw new Error("run scripts/deploy.ts first");
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  return { pool: process.env.POOL ?? d.pool, token: d.token };
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const { pool: poolAddr, token: tokenAddr } = loadDeployment();

  const pool = (await ethers.getContractAt("ConfidentialPrizePool", poolAddr, signer)) as unknown as Contract;
  const token = (await ethers.getContractAt("ERC7984Mock", tokenAddr, signer)) as unknown as Contract;
  console.log(`pool  ${poolAddr}`);
  console.log(`token ${tokenAddr}\n`);

  const stateFile = path.join(OUT, "demo-participants.json");
  let keys: string[];
  if (fs.existsSync(stateFile)) {
    keys = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    console.log(`reusing ${keys.length} participants`);
  } else {
    keys = Array.from({ length: PARTICIPANTS }, () => ethers.Wallet.createRandom().privateKey);
    fs.writeFileSync(stateFile, JSON.stringify(keys, null, 2));
    console.log(`created ${keys.length} participants`);
  }

  // Deposits are staggered on purpose: a time-weighted pool where everyone joins
  // at the same instant demonstrates nothing about time weighting.
  const wallets = keys.map((k) => new ethers.Wallet(k, ethers.provider));
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i]!;
    const already = Number(await pool.observationCount(w.address));
    if (already > 0) continue;
    // Different sizes so the odds differ visibly, and large enough that the
    // yield calculation does not round to zero over a few minutes.
    const amount = BigInt(100_000 * (i + 1));
    await (await signer.sendTransaction({ to: w.address, value: ethers.parseEther("0.01") })).wait();
    await (await token.mint(w.address, amount * 2n)).wait();
    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * 24 * 3600;
    await (await (token.connect(w) as Contract).setOperator(poolAddr, until)).wait();
    const enc = await fhevm.createEncryptedInput(poolAddr, w.address).add64(amount).encrypt();
    await (await (pool.connect(w) as Contract).deposit(enc.handles[0], enc.inputProof)).wait();
    console.log(`  ${w.address} deposited ${amount}`);
  }

  // ---- harvest first -----------------------------------------------------
  // The reserve is empty until this runs. If a prize is paid after it, the
  // money came from yield on these deposits and nowhere else.
  await (await pool.harvest()).wait();
  console.log(`
harvested — the reserve is funded from yield alone`);

  // ---- the round ---------------------------------------------------------
  const before = Number(await pool.drawCount());
  const last = before > 0 ? await pool.drawAt(before) : null;
  let id = before;
  if (last === null || Number(last.status) === 2) {
    await (await pool.openDraw()).wait();
    id = Number(await pool.drawCount());
    console.log(`\ndraw ${id} opened — weights frozen, randomness drawn and still encrypted`);
  } else {
    console.log(`\ndraw ${id} was already open — finishing it`);
  }

  const d = await pool.drawAt(id);
  const t0 = Date.now();
  const pub = await fhevm.publicDecrypt([d.encR, d.encTotalWeight]);
  await (await pool.revealDraw(id, pub.abiEncodedClearValues, pub.decryptionProof)).wait();
  const revealed = await pool.drawAt(id);
  console.log(`draw ${id} revealed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  R           ${revealed.r}`);
  console.log(`  totalWeight ${revealed.totalWeight}`);

  const addrs = wallets.map((w) => w.address);
  const rc = await (await pool.accrueMany(addrs, id)).wait();
  console.log(`\naccrued all ${addrs.length} in ONE transaction, ${rc.gasUsed} gas`);

  // Every participant is credited, winner or not — the transactions are the same
  // shape, so the chain shows nothing about who won. Only the holder can look.
  console.log(`\nwinnings, readable only by each holder:`);
  for (const w of wallets) {
    const h = await pool.winningsOf(w.address);
    const v = h === ethers.ZeroHash ? 0n : await fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, w);
    const threshold = await pool.thresholdFor(id, w.address);
    console.log(`  ${w.address}  won ${String(v).padStart(5)}   threshold ${threshold}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
