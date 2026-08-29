/**
 * Provisions the second EOA the other spikes need.
 *
 * A6 is only a valid test when the delegator and the delegate are different
 * addresses, and the latency spike needs a recipient that is not the sender.
 * This generates a fresh session key, writes it to .env (never to stdout), and
 * funds it from the deployer.
 *
 *   pnpm spike:accounts
 */
import { ethers } from "hardhat";
import { formatEther, parseEther, Wallet } from "ethers";
import { record, upsertEnv } from "./_shared";

const TARGET_BALANCE = parseEther("0.05");

async function main(): Promise<void> {
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("no signer — is DEPLOYER_PRIVATE_KEY set?");

  const deployerBal = await provider.getBalance(deployer.address);
  console.log(`deployer   ${deployer.address}  ${formatEther(deployerBal)} ETH`);

  let sessionPk = process.env.SESSION_PRIVATE_KEY;
  let created = false;
  if (sessionPk === undefined || sessionPk.length === 0 || sessionPk === "0x...") {
    sessionPk = Wallet.createRandom().privateKey;
    upsertEnv("SESSION_PRIVATE_KEY", sessionPk);
    created = true;
  }
  const session = new Wallet(sessionPk, provider);

  if (session.address.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("session key equals deployer key — A6 would be vacuous");
  }
  console.log(
    `session    ${session.address}  ${created ? "(generated, written to .env)" : "(from .env)"}`,
  );

  const sessionBal = await provider.getBalance(session.address);
  console.log(`           balance ${formatEther(sessionBal)} ETH`);

  if (sessionBal < TARGET_BALANCE) {
    const top = TARGET_BALANCE - sessionBal;
    console.log(`funding    sending ${formatEther(top)} ETH ...`);
    const tx = await deployer.sendTransaction({ to: session.address, value: top });
    const receipt = await tx.wait();
    console.log(`           mined in block ${receipt?.blockNumber} (${tx.hash})`);
  } else {
    console.log(`funding    skipped, already >= ${formatEther(TARGET_BALANCE)} ETH`);
  }

  const out = record("accounts", {
    deployer: deployer.address,
    session: session.address,
    sessionGenerated: created,
    sessionBalanceWei: (await provider.getBalance(session.address)).toString(),
  });
  console.log(`\nrecorded -> ${out}`);
  console.log("NOTE: the session private key is in .env only. It was never printed.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
