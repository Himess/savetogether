/**
 * Does the solvency bit report BOTH states, and does it match the reserve?
 *
 * A green tick nobody has seen turn red is a claim. Draw 1 opened against an
 * almost-empty reserve, so a real negative exists on this pool — and the reserve
 * has been filling from harvest since, so the later draws are the positive.
 */
import { ethers, fhevm } from "hardhat";
const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";

async function main() {
  await fhevm.initializeCLIApi();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  const n = Number(await pool.drawCount());
  const cover = Number(await pool.SOLVENCY_COVER());
  const grand = Number(await pool.tierPrize(0));
  console.log(`bar: ${cover} x ${grand / 1e6} = ${(cover * grand) / 1e6} cUSDC\n`);

  for (let i = 1; i <= n; i++) {
    const h = await pool.solventAt(i);
    if (h === ethers.ZeroHash) { console.log(`  draw ${i}  no bit`); continue; }
    const dec = await fhevm.publicDecrypt([h]);
    const v = Object.values(dec.clearValues ?? dec)[0];
    console.log(`  draw ${i}  solvent = ${v}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
