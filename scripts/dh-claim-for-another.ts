/**
 * DH — claiming for somebody else, on chain, once.
 *
 * The site says "anyone may call it for anyone" on four surfaces and, until the
 * control this script backs, only ever let you call it for yourself. A control
 * that demonstrates a property and has never been used is still only a claim,
 * so this sends the transaction and records the hash.
 *
 * The target is a real depositor and NOT the sender. That is the whole point:
 * the sender learns nothing from the transaction — no revert on a loser, no
 * different gas, no readable amount — because `claim` is `_drain` plus an event
 * and `_drain` runs the same operations either way.
 *
 *   npx hardhat run scripts/dh-claim-for-another.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";

const POOL = "0x894F6492357277CF36e9973787663AE9F73387BE";

/** A depositor on this pool who is not the key running this script. */
const TARGET = "0xF46b0357A6CD11935a8B5e17c329F24544eF316F";

async function main() {
  const [me] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL);

  if (me.address.toLowerCase() === TARGET.toLowerCase()) {
    throw new Error("target is the sender — that demonstrates nothing");
  }

  console.log(`sender  ${me.address}`);
  console.log(`target  ${TARGET}`);

  // Before and after are HANDLES, not values. Neither this script nor the
  // sender can read them; only the target's key can. Recording that the handle
  // moved is the strongest thing an outside observer is entitled to.
  const pendingBefore = await pool.pendingOf(TARGET);
  console.log(`\npendingOf(target) before  ${pendingBefore}`);

  const tx = await pool.claim(TARGET);
  const r = await tx.wait();
  console.log(`\nclaim(target)  ${r!.hash}`);
  console.log(`  block ${r!.blockNumber}   gas ${r!.gasUsed}`);

  const pendingAfter = await pool.pendingOf(TARGET);
  console.log(`pendingOf(target) after   ${pendingAfter}`);
  console.log(`  handle changed: ${pendingBefore !== pendingAfter}`);

  // The event names the subject and carries no amount, which is the shape the
  // design needs: "somebody settled this address" is public, "how much" is not.
  const claimed = r!.logs
    .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "Claimed");
  console.log(`\nClaimed event: ${claimed ? `user=${claimed.args[0]} at=${claimed.args[1]}` : "none"}`);
  console.log("no amount in the event, by design");

  const out = {
    what: "claim(address) sent by one account for another",
    pool: POOL,
    sender: me.address,
    target: TARGET,
    tx: r!.hash,
    block: r!.blockNumber,
    gas: String(r!.gasUsed),
    pendingHandleBefore: pendingBefore,
    pendingHandleAfter: pendingAfter,
    at: new Date().toISOString(),
  };
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/dh-claim-for-another.json", JSON.stringify(out, null, 2));
  console.log(`\nwrote out/dh-claim-for-another.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
