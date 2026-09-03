/**
 * AC6 — keep several participants in the pool, permanently.
 *
 * A visitor arriving as the sole depositor wins the ordinary tier every single
 * round, and the site then has to explain that away in a paragraph nobody wants
 * to read. It is also the least interesting version of the product: with one
 * participant the odds are 100% and the tier structure never shows itself.
 *
 * Four seeded wallets plus the deployer make five. That is enough that the
 * ordinary tier moves between addresses, the middle tier fires a few times a
 * day, and a visitor's own odds are a number rather than a certainty.
 *
 * THE GAS IS THE CONSTRAINT AND IT IS WHY THERE ARE FOUR AND NOT TEN. Every
 * participant must be accrued every draw — that is the price of unconditional
 * accrual, measured at 386,608 gas each — so headcount and cadence trade against
 * each other directly:
 *
 *     1 participant  @ 1800s   0.17 ETH/day
 *     5 participants @ 1800s   0.34 ETH/day
 *     5 participants @ 2400s   0.25 ETH/day   <- chosen
 *     7 participants @ 2400s   0.32 ETH/day
 *
 * Deterministic wallets, derived from a fixed phrase, so this is reproducible and
 * the same five addresses come back if it is ever re-run.
 *
 *   npx hardhat run scripts/seed-participants.ts --network sepolia
 *
 * STOP THE KEEPER FIRST — it signs with the deployer's key.
 */
import { ethers, fhevm } from "hardhat";
import type { HDNodeWallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const PHRASE = "savetogether seed participant";
const COUNT = 4;

/** Enough for setOperator + deposit, with room for a retry. */
const GAS_EACH = ethers.parseEther("0.012");

/** Unequal on purpose: equal balances make every threshold the same shape. */
const AMOUNTS = [3_000n, 2_000n, 1_200n, 800n];

const U = 1_000_000n;

const WRAPPER = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function setOperator(address operator, uint48 until)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];
const ERC20 = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function wallets(): HDNodeWallet[] {
  return Array.from({ length: COUNT }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(
      ethers.Mnemonic.fromEntropy(ethers.id(PHRASE).slice(0, 34)).phrase,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    ),
  );
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [deployer] = await ethers.getSigners();
  const me = await deployer!.getAddress();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "out", "deployment.json"), "utf8"),
  ) as { pool: string; token: string; underlying: string };

  const usdc = new ethers.Contract(d.underlying, ERC20, deployer!);
  const cusdc = new ethers.Contract(d.token, WRAPPER, deployer!);
  const pool = await ethers.getContractAt("ConfidentialPrizePool", d.pool, deployer!);

  const total = AMOUNTS.reduce((a, b) => a + b, 0n) * U;
  console.log(`minting ${total / U} USDC and wrapping it to ${COUNT} participants\n`);
  await (await usdc.mint!(me, total)).wait();
  await (await usdc.approve!(d.token, total)).wait();

  const ws = wallets();
  const out: { address: string; amount: string }[] = [];

  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!.connect(ethers.provider);
    const amount = AMOUNTS[i]! * U;
    console.log(`${i + 1}. ${w.address}  ${AMOUNTS[i]} cUSDC`);

    const bal = await ethers.provider.getBalance(w.address);
    if (bal < GAS_EACH / 2n) {
      await (await deployer!.sendTransaction({ to: w.address, value: GAS_EACH })).wait();
      console.log(`   funded with ${ethers.formatEther(GAS_EACH)} ETH`);
    }

    // The wrapper takes a recipient, so this needs no transfer afterwards.
    await (await cusdc.wrap!(w.address, amount)).wait();

    const theirToken = new ethers.Contract(d.token, WRAPPER, w);
    await (await theirToken.setOperator!(d.pool, Math.floor(Date.now() / 1000) + 365 * 24 * 3600)).wait();

    // Encrypted for THIS participant against THIS pool — the proof binds both.
    const enc = await fhevm.createEncryptedInput(d.pool, w.address).add64(amount).encrypt();
    await (await pool.connect(w).deposit!(enc.handles[0], enc.inputProof)).wait();
    console.log(`   deposited`);

    out.push({ address: w.address, amount: amount.toString() });
  }

  const file = path.join(__dirname, "..", "out", "participants.json");
  fs.writeFileSync(file, JSON.stringify({ pool: d.pool, phrase: PHRASE, participants: out }, null, 2));
  console.log(`\nwritten to out/participants.json`);
  console.log(`the pool now has ${COUNT + 1} depositors, so nobody wins by default`);
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
