/**
 * A6 — the load-bearing assumption.
 *
 * Can a DELEGATE address user-decrypt a handle owned by the DELEGATOR, through
 * the relayer SDK, signing with the delegate's OWN EIP-712 key?
 *
 * If this fails the whole read-authority design changes, so the spike is built
 * to be falsifiable: a negative control runs BEFORE the delegation, and the
 * decrypted value is cross-checked against the delegator's own userDecrypt.
 *
 *   pnpm spike:delegation
 */
import { ethers } from "hardhat";
import { Contract, Wallet } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import {
  call,
  record,
  requireEnv,
  signEip712,
  type Eip712Payload,
  type Handle,
  type TxLike,
} from "./_shared";

const ACL_ADDRESS = SepoliaConfig.aclContractAddress;
// Live Zama confidential wrapper on Sepolia. Not hardcoded policy — it is the
// decryption *context* the delegation is scoped to, discovered via registry.ts.
const TOKEN = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639"; // cUSDC

const ACL_ABI = [
  "function delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate)",
  "function revokeDelegationForUserDecryption(address delegate, address contractAddress)",
  "function getUserDecryptionDelegationExpirationDate(address delegator, address delegate, address contractAddress) view returns (uint64)",
];
const TOKEN_ABI = ["function confidentialBalanceOf(address) view returns (bytes32)"];

type Step = { step: string; ok: boolean; detail: string };
const log: Step[] = [];
const note = (step: string, ok: boolean, detail: string): void => {
  log.push({ step, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${step.padEnd(38)} ${detail}`);
};

async function main(): Promise<void> {
  const provider = ethers.provider;
  const [delegator] = await ethers.getSigners();
  if (delegator === undefined) throw new Error("no signer");
  const delegate = new Wallet(requireEnv("SESSION_PRIVATE_KEY"), provider);

  console.log(`delegator (holder)   ${delegator.address}`);
  console.log(`delegate  (session)  ${delegate.address}`);
  console.log(`context   (token)    ${TOKEN}`);
  console.log(`ACL                  ${ACL_ADDRESS}\n`);

  if (delegator.address.toLowerCase() === delegate.address.toLowerCase()) {
    throw new Error("delegator == delegate: the test would be vacuous");
  }

  const instance = await createInstance({
    ...SepoliaConfig,
    network: requireEnv("SEPOLIA_RPC_URL"),
  });
  const acl = new Contract(ACL_ADDRESS, ACL_ABI, provider);
  const token = new Contract(TOKEN, TOKEN_ABI, provider);

  const handle: Handle = await call<Handle>(token, "confidentialBalanceOf")(delegator.address);
  note("handle exists", handle !== ethers.ZeroHash, handle);
  if (handle === ethers.ZeroHash)
    throw new Error("delegator has no cUSDC balance handle to test with");

  const pairs = [{ handle, contractAddress: TOKEN }];
  const start = Math.floor(Date.now() / 1000);
  const days = 1;

  // --- 1. NEGATIVE CONTROL, before any delegation exists -------------------
  const before: bigint = await call<bigint>(acl, "getUserDecryptionDelegationExpirationDate")(
    delegator.address,
    delegate.address,
    TOKEN,
  );
  note("no delegation before test", before === 0n, `expiry=${before}`);

  if (before === 0n) {
    const kp = instance.generateKeypair();
    const e = instance.createDelegatedUserDecryptEIP712(
      kp.publicKey,
      [TOKEN],
      delegator.address,
      start,
      days,
    );
    const sig = await signEip712(delegate, e as Eip712Payload);
    let refused = false;
    let why = "";
    try {
      await instance.delegatedUserDecrypt(
        pairs,
        kp.privateKey,
        kp.publicKey,
        sig,
        [TOKEN],
        delegator.address,
        delegate.address,
        start,
        days,
      );
    } catch (err) {
      refused = true;
      why = (err as Error).message.slice(0, 130);
    }
    note(
      "REFUSED without delegation",
      refused,
      refused ? why : "DECRYPTED ANYWAY — control failed",
    );
  }

  // --- 2. Delegate -----------------------------------------------------------
  const expiry = BigInt(start + 7 * 24 * 3600);
  const tx = await call<TxLike>(acl.connect(delegator), "delegateForUserDecryption")(
    delegate.address,
    TOKEN,
    expiry,
  );
  const rcpt = await tx.wait();
  note(
    "delegateForUserDecryption sent",
    rcpt?.status === 1,
    `block ${rcpt?.blockNumber} gas ${rcpt?.gasUsed}`,
  );

  const after: bigint = await call<bigint>(acl, "getUserDecryptionDelegationExpirationDate")(
    delegator.address,
    delegate.address,
    TOKEN,
  );
  note("ACL records the delegation", after === expiry, `expiry=${after} (expected ${expiry})`);

  // --- 3. POSITIVE: delegate decrypts with its OWN signature -----------------
  const kp2 = instance.generateKeypair();
  const e2 = instance.createDelegatedUserDecryptEIP712(
    kp2.publicKey,
    [TOKEN],
    delegator.address,
    start,
    days,
  );
  const sig2 = await signEip712(delegate, e2 as Eip712Payload);

  let delegatedValue: string | undefined;
  try {
    const res = await instance.delegatedUserDecrypt(
      pairs,
      kp2.privateKey,
      kp2.publicKey,
      sig2,
      [TOKEN],
      delegator.address,
      delegate.address,
      start,
      days,
    );
    delegatedValue = String(res[handle]);
    note("DELEGATE DECRYPTED", delegatedValue !== undefined, `value=${delegatedValue}`);
  } catch (err) {
    note("DELEGATE DECRYPTED", false, (err as Error).message.slice(0, 200));
  }

  // --- 4. Cross-check against the delegator's own userDecrypt ---------------
  let ownValue: string | undefined;
  try {
    const kp3 = instance.generateKeypair();
    const e3 = instance.createEIP712(kp3.publicKey, [TOKEN], start, days);
    const sig3 = await signEip712(delegator, e3 as Eip712Payload);
    const res = await instance.userDecrypt(
      pairs,
      kp3.privateKey,
      kp3.publicKey,
      sig3,
      [TOKEN],
      delegator.address,
      start,
      days,
    );
    ownValue = String(res[handle]);
    note("holder's own userDecrypt", true, `value=${ownValue}`);
  } catch (err) {
    note("holder's own userDecrypt", false, (err as Error).message.slice(0, 160));
  }

  note(
    "values agree",
    delegatedValue !== undefined && delegatedValue === ownValue,
    `delegate=${delegatedValue} holder=${ownValue}`,
  );

  const out = record("delegation", {
    delegator: delegator.address,
    delegate: delegate.address,
    token: TOKEN,
    acl: ACL_ADDRESS,
    handle,
    expiry: expiry.toString(),
    delegatedValue,
    ownValue,
    steps: log,
  });
  const failed = log.filter((s) => !s.ok);
  console.log(`\nrecorded -> ${out}`);
  console.log(
    failed.length === 0 ? "\nA6: VERIFIED" : `\nA6: ${failed.length} step(s) failed — see above`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
