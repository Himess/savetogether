/**
 * Send the exact call the "Run the pool yourself" button sends.
 *
 * A control that has never been pressed is a claim. This sends `harvest()` — no
 * access control, the same function and the same arguments the button builds —
 * from a wallet, and prints the hash.
 *
 * It does not prove the BUTTON works, only the call behind it. That distinction
 * is the point of saying it out loud.
 */
import { ethers } from "hardhat";
const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";

async function main() {
  const [me] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);
  console.log(`caller ${me!.address}`);
  const t = await (await pool.harvest()).wait();
  console.log(`harvest()  ${t!.hash}  ${t!.gasUsed} gas  block ${t!.blockNumber}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
