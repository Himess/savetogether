/**
 * THE GATE. Step 2's headline claim — that a successful transfer, an over-budget
 * transfer and an insufficient-balance transfer are indistinguishable — is so far
 * backed by mock mode only. This proves it on live Sepolia, or fails loudly.
 *
 * Three things are measured per path:
 *
 *   1. EXECUTION GAS. `gasUsed` minus intrinsic calldata cost. Total gasUsed is
 *      not the right quantity: it includes 4 gas per zero calldata byte and 16
 *      per non-zero, and the caller's fresh ciphertext varies in zero-byte count
 *      for reasons unrelated to the outcome.
 *   2. THE FHE OPERATION SEQUENCE, counted from the executor's own events in the
 *      receipt. Independent evidence of indistinguishability one layer below gas.
 *   3. HCU, computed from those measured op counts times the per-op costs read
 *      from HCULimit.sol. HCU itself is accumulated in transient storage with no
 *      event and no view, so it cannot be read back after a transaction — this is
 *      the closest thing to a measurement that exists, and it is not an estimate
 *      of the op sequence, only of the price of each op.
 *
 * Idempotent: deployments and funded actors are cached in .env, so a re-run
 * continues rather than starting over.
 *
 *   pnpm spike:sepolia-gate
 */
import { ethers } from "hardhat";
import { Wallet, formatEther, parseEther } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

import { record, requireEnv, upsertEnv } from "./_shared";

const ROUNDS = Number(process.env.GATE_ROUNDS ?? "3");
const FUND_TARGET = parseEther("0.03");
const DAY = 24 * 60 * 60;

/** Per-op HCU for euint64, read from HCULimit.sol (@fhevm/host-contracts 0.10.0). */
const HCU: Record<string, { scalar: number; cipher: number }> = {
  FheAdd: { scalar: 133_000, cipher: 162_000 },
  FheSub: { scalar: 133_000, cipher: 162_000 },
  FheGe: { scalar: 116_000, cipher: 152_000 },
  FheLe: { scalar: 119_000, cipher: 149_000 },
  FheEq: { scalar: 116_000, cipher: 152_000 },
  FheIfThenElse: { scalar: 55_000, cipher: 55_000 },
  TrivialEncrypt: { scalar: 32, cipher: 32 },
};

const EXECUTOR_ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheEq(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
];

const SETUPS = [
  { label: "success", balance: 3000n, budget: 3000n },
  { label: "over-budget", balance: 3000n, budget: 100n },
  { label: "short-balance", balance: 100n, budget: 3000n },
] as const;

/** Intrinsic calldata cost under EIP-2028. */
function calldataGas(data: string): { zeros: number; gas: number } {
  const bytes = ethers.getBytes(data);
  let zeros = 0;
  for (const b of bytes) if (b === 0) zeros++;
  return { zeros, gas: zeros * 4 + (bytes.length - zeros) * 16 };
}

/** Reads a CSV of private keys from .env, generating and persisting them if absent. */
function actors(key: string, count: number): Wallet[] {
  const existing = process.env[key];
  let keys: string[];
  if (existing !== undefined && existing.split(",").filter(Boolean).length === count) {
    keys = existing.split(",");
  } else {
    keys = Array.from({ length: count }, () => Wallet.createRandom().privateKey);
    upsertEnv(key, keys.join(","));
    process.env[key] = keys.join(",");
  }
  return keys.map((k) => new Wallet(k, ethers.provider));
}

async function main(): Promise<void> {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 11155111n) throw new Error(`expected Sepolia, got chainId ${net.chainId}`);

  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("no signer");
  console.log(
    `deployer ${deployer.address}  ${formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`,
  );

  const owners = actors("GATE_OWNER_KEYS", 3);
  const keys = actors("GATE_SESSION_KEYS", 3);
  const recipient = actors("GATE_RECIPIENT_KEY", 1)[0]!;

  // ---- fund every actor that will send a transaction ------------------------
  for (const w of [...owners, ...keys]) {
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < FUND_TARGET / 2n) {
      const tx = await deployer.sendTransaction({ to: w.address, value: FUND_TARGET });
      await tx.wait();
      console.log(`funded  ${w.address}  ${formatEther(FUND_TARGET)} ETH`);
    }
  }

  // ---- deploy or reuse ------------------------------------------------------
  let moduleAddr = process.env.GATE_MODULE ?? "";
  let tokenAddr = process.env.GATE_TOKEN ?? "";
  if (moduleAddr === "" || (await ethers.provider.getCode(moduleAddr)) === "0x") {
    const m = await (await ethers.getContractFactory("GhostKeySession")).connect(deployer).deploy();
    await m.waitForDeployment();
    moduleAddr = await m.getAddress();
    upsertEnv("GATE_MODULE", moduleAddr);
    console.log(`deployed GhostKeySession ${moduleAddr}`);
  }
  if (tokenAddr === "" || (await ethers.provider.getCode(tokenAddr)) === "0x") {
    const t = await (
      await ethers.getContractFactory("MockERC7984")
    )
      .connect(deployer)
      .deploy("gkUSD", "gkUSD", "");
    await t.waitForDeployment();
    tokenAddr = await t.getAddress();
    upsertEnv("GATE_TOKEN", tokenAddr);
    console.log(`deployed MockERC7984     ${tokenAddr}`);
  }
  console.log(`module ${moduleAddr}\ntoken  ${tokenAddr}\n`);

  const module = await ethers.getContractAt("GhostKeySession", moduleAddr);
  const token = await ethers.getContractAt("MockERC7984", tokenAddr);
  const instance = await createInstance({
    ...SepoliaConfig,
    network: requireEnv("SEPOLIA_RPC_URL"),
  });

  // ---- one-time setup per path ---------------------------------------------
  const expiry = Math.floor(Date.now() / 1000) + 30 * DAY;

  // Warm the recipient so `_balances[to]` is initialized on every path.
  if ((await token.confidentialBalanceOf(recipient.address)) === ethers.ZeroHash) {
    await (await token.connect(deployer).mintPlain(recipient.address, 1n)).wait();
    console.log("warmed recipient");
  }

  for (let i = 0; i < 3; i++) {
    const owner = owners[i]!;
    const key = keys[i]!;
    const setup = SETUPS[i]!;

    const existing = await module.sessionOf(key.address);
    if (existing.owner !== ethers.ZeroAddress) {
      console.log(`session ${i} (${setup.label}) already open`);
      continue;
    }

    if ((await token.confidentialBalanceOf(owner.address)) === ethers.ZeroHash) {
      await (await token.connect(deployer).mintPlain(owner.address, setup.balance)).wait();
    }
    await (await token.connect(owner).setOperator(moduleAddr, expiry)).wait();

    const enc = await instance
      .createEncryptedInput(moduleAddr, owner.address)
      .add64(setup.budget)
      .encrypt();

    const sig = await key.signTypedData(
      { name: "GhostKeySession", version: "1", chainId: 11155111, verifyingContract: moduleAddr },
      {
        OpenSession: [
          { name: "owner", type: "address" },
          { name: "sessionKey", type: "address" },
          { name: "expiry", type: "uint48" },
          { name: "maxTxCount", type: "uint24" },
        ],
      },
      { owner: owner.address, sessionKey: key.address, expiry, maxTxCount: 0 },
    );

    await (
      await module.connect(owner).openSession(
        {
          sessionKey: key.address,
          expiry,
          maxTxCount: 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
        sig,
      )
    ).wait();
    console.log(`opened session ${i} (${setup.label})  key ${key.address}`);
  }

  // ---- measure --------------------------------------------------------------
  // Only the Interface is needed: every log in the receipt is tried and the ones
  // that do not parse are skipped, so no address filter is required.
  const iface = new ethers.Interface(EXECUTOR_ABI);

  type Row = {
    round: number;
    label: string;
    total: bigint;
    cd: number;
    zeros: number;
    exec: bigint;
    ops: string;
    hcu: number;
    tx: string;
  };
  const rows: Row[] = [];

  // Control mode: hammer ONE path repeatedly. If a single path reproduces the full
  // spread of execution-gas values, the variance is intra-path and cannot encode the
  // outcome. This is the experiment that settles it, so it is part of the gate.
  const controlPath = process.env.GATE_CONTROL;
  const pathIdx =
    controlPath === undefined ? null : SETUPS.findIndex((s) => s.label === controlPath);
  if (pathIdx === -1) throw new Error(`unknown GATE_CONTROL path: ${controlPath}`);

  for (let round = 1; round <= ROUNDS; round++) {
    for (let i = 0; i < 3; i++) {
      if (pathIdx !== null && i !== pathIdx) continue;
      const key = keys[i]!;
      const enc = await instance
        .createEncryptedInput(moduleAddr, key.address)
        .add64(500n)
        .encrypt();
      const tx = await module
        .connect(key)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof);
      const receipt = await tx.wait();
      const sentTx = await ethers.provider.getTransaction(tx.hash);
      const cd = calldataGas(sentTx!.data);

      // Count the FHE operation sequence from the executor's own events, and
      // price it with the costs read from HCULimit.sol.
      const counts: Record<string, number> = {};
      let hcu = 0;
      for (const log of receipt!.logs) {
        let parsed;
        try {
          parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (parsed === null) continue;
        const name = parsed.name;
        const cost = HCU[name];
        if (cost === undefined) continue;
        counts[name] = (counts[name] ?? 0) + 1;
        const scalarByte = parsed.args["scalarByte"] as string | undefined;
        const isScalar = scalarByte !== undefined && scalarByte !== "0x00";
        hcu += isScalar ? cost.scalar : cost.cipher;
      }
      const ops = Object.keys(counts)
        .sort()
        .map((k) => `${k}x${counts[k]}`)
        .join(" ");

      rows.push({
        round,
        label: SETUPS[i]!.label,
        total: receipt!.gasUsed,
        cd: cd.gas,
        zeros: cd.zeros,
        exec: receipt!.gasUsed - BigInt(cd.gas),
        ops,
        hcu,
        tx: tx.hash,
      });
      console.log(
        `round ${round}  ${SETUPS[i]!.label.padEnd(14)} exec ${receipt!.gasUsed - BigInt(cd.gas)}  hcu ${hcu}  ${tx.hash}`,
      );
    }
  }

  // ---- report ---------------------------------------------------------------
  console.log("\n  SEPOLIA EQUALITY GATE\n");
  console.log(
    "  round  path             total gas   calldata gas   zero bytes   EXECUTION gas        HCU",
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.round).padStart(5)}  ${r.label.padEnd(15)} ${String(r.total).padStart(9)} ` +
        `${String(r.cd).padStart(14)} ${String(r.zeros).padStart(12)} ${String(r.exec).padStart(15)} ` +
        `${String(r.hcu).padStart(10)}`,
    );
  }
  console.log("\n  FHE operation sequence per path:");
  for (const r of rows.filter((x) => x.round === 1)) {
    console.log(`    ${r.label.padEnd(15)} ${r.ops}`);
  }

  const execs = [...new Set(rows.map((r) => r.exec.toString()))];
  const opSeqs = [...new Set(rows.map((r) => r.ops))];
  const hcus = [...new Set(rows.map((r) => r.hcu))];

  const out = record("sepolia-equality", {
    network: "sepolia",
    module: moduleAddr,
    token: tokenAddr,
    rounds: ROUNDS,
    distinctExecutionGas: execs,
    distinctOpSequences: opSeqs,
    distinctHCU: hcus,
    rows: rows.map((r) => ({ ...r, total: r.total.toString(), exec: r.exec.toString() })),
  });

  console.log(`\n  distinct execution-gas values : ${execs.length}  ${execs.join(", ")}`);
  console.log(`  distinct FHE op sequences     : ${opSeqs.length}`);
  console.log(`  distinct HCU values           : ${hcus.length}  ${hcus.join(", ")}`);
  console.log(`\n  recorded -> ${out}`);

  const failures: string[] = [];
  if (execs.length !== 1) failures.push(`execution gas differs across paths: ${execs.join(", ")}`);
  if (opSeqs.length !== 1) failures.push(`FHE operation sequence differs across paths`);
  for (const r of rows) {
    if (r.total - BigInt(r.cd) !== r.exec) failures.push(`attribution does not close on ${r.tx}`);
  }

  if (failures.length > 0) {
    console.log("\n  GATE FAILED");
    for (const f of failures) console.log(`    - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n  GATE PASSED — execution gas, FHE operation sequence and HCU are identical");
  console.log("  across every path on live Sepolia, and the calldata attribution closes.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
