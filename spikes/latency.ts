/**
 * The latency spike. Measures wall-clock time per phase of one confidential
 * transfer on live Sepolia, repeated N times.
 *
 * This number decides the chat UX: at 60s per send we design around optimistic
 * responses and background settlement; at 8s we do not.
 *
 *   pnpm spike:latency
 */
import { ethers } from "hardhat";
import { Contract, Wallet } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import {
  call,
  now,
  record,
  requireEnv,
  signEip712,
  stats,
  table,
  type Eip712Payload,
  type Handle,
  type TxLike,
} from "./_shared";

const TOKEN = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639"; // cUSDC
const TOKEN_ABI = [
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)",
];
const AMOUNT = 1n; // 1e-6 cUSDC — deliberately negligible

type Run = Record<string, number>;

async function main(): Promise<void> {
  const [holder] = await ethers.getSigners();
  if (holder === undefined) throw new Error("no signer");
  const recipient = new Wallet(requireEnv("SESSION_PRIVATE_KEY"), ethers.provider);
  const runs = Number(process.env.LATENCY_RUNS ?? "5");

  const instance = await createInstance({
    ...SepoliaConfig,
    network: requireEnv("SEPOLIA_RPC_URL"),
  });
  const token = new Contract(TOKEN, TOKEN_ABI, holder);

  console.log(`holder ${holder.address}  ->  recipient ${recipient.address}`);
  console.log(`token  ${TOKEN}   runs ${runs}   amount ${AMOUNT}\n`);

  const decryptOnce = async (handle: Handle): Promise<string> => {
    const kp = instance.generateKeypair();
    const start = Math.floor(Date.now() / 1000);
    const sig = await signEip712(
      holder,
      instance.createEIP712(kp.publicKey, [TOKEN], start, 1) as Eip712Payload,
    );
    const res = await instance.userDecrypt(
      [{ handle, contractAddress: TOKEN }],
      kp.privateKey,
      kp.publicKey,
      sig,
      [TOKEN],
      holder.address,
      start,
      1,
    );
    return String(res[handle]);
  };

  const samples: Run[] = [];
  for (let i = 1; i <= runs; i++) {
    const r: Run = {};
    const t0 = now();

    // Phase 1: encrypt + ZK proof + relayer registration. The SDK bundles all
    // three inside encrypt(); it does not expose them separately.
    let t = now();
    const enc = await instance.createEncryptedInput(TOKEN, holder.address).add64(AMOUNT).encrypt();
    r["encrypt + proof + register"] = now() - t;

    // Phase 2: submit -> mined
    t = now();
    const tx = await call<TxLike>(token, "confidentialTransfer")(
      recipient.address,
      enc.handles[0],
      enc.inputProof,
    );
    await tx.wait();
    r["submit -> mined"] = now() - t;

    // Phase 3: coprocessor settlement. The handle exists the moment the tx is
    // mined, but the ciphertext is not decryptable until the coprocessor has
    // computed it. We poll userDecrypt until the first success; that boundary
    // IS the settlement signal — there is no event for it.
    const newHandle: Handle = await call<Handle>(token, "confidentialBalanceOf")(holder.address);
    t = now();
    let value = "";
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        value = await decryptOnce(newHandle);
        break;
      } catch {
        if (now() - t > 180_000) throw new Error("settlement did not complete within 180s");
      }
    }
    r["settle + first decrypt"] = now() - t;
    r["poll attempts"] = attempts;

    // Phase 4: a warm decrypt of the same, now-settled handle. Subtracting this
    // from phase 3 isolates coprocessor settlement from decryption itself.
    t = now();
    await decryptOnce(newHandle);
    r["decrypt (warm)"] = now() - t;

    r["settlement (derived)"] = Math.max(0, r["settle + first decrypt"]! - r["decrypt (warm)"]!);
    r["END TO END"] = now() - t0;

    samples.push(r);
    console.log(
      `run ${i}/${runs}  e2e ${(r["END TO END"]! / 1000).toFixed(1)}s  ` +
        `(enc ${(r["encrypt + proof + register"]! / 1000).toFixed(1)}s, ` +
        `tx ${(r["submit -> mined"]! / 1000).toFixed(1)}s, ` +
        `settle ${(r["settlement (derived)"]! / 1000).toFixed(1)}s, ` +
        `dec ${(r["decrypt (warm)"]! / 1000).toFixed(1)}s, polls ${attempts})  bal=${value}`,
    );
  }

  const phases = [
    "encrypt + proof + register",
    "submit -> mined",
    "settle + first decrypt",
    "settlement (derived)",
    "decrypt (warm)",
    "END TO END",
  ];
  const rows = phases.map((p) =>
    stats(
      p,
      samples.map((s) => s[p]!),
    ),
  );
  console.log("\n" + table(rows));

  const out = record("latency", { token: TOKEN, runs, rpc: "alchemy", samples, summary: rows });
  console.log(`\nrecorded -> ${out}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
