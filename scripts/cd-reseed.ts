/** Puts the seed principal back after the withdraw(max) exercise emptied it. */
import { ethers, fhevm } from "hardhat";
const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";
const TOKEN = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
async function main() {
  await fhevm.initializeCLIApi();
  const [me] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  const token = await ethers.getContractAt("ERC7984Mock", TOKEN);
  const until = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  await (await token.setOperator(POOL, until)).wait();
  const SEED = 12_000n * 1_000_000n;
  const enc = await fhevm.createEncryptedInput(POOL, me!.address).add64(SEED).encrypt();
  const t = await (await pool.deposit(enc.handles[0], enc.inputProof)).wait();
  console.log(`re-seeded 12,000 cUSDC   ${t!.hash}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
