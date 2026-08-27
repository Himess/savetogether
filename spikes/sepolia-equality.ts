/**
 * THE GATE. Proves — or refutes — on live Sepolia that a successful transfer, an
 * over-budget transfer and an insufficient-balance transfer are indistinguishable.
 *
 * Three quantities are measured per send:
 *
 *   1. EXECUTION GAS. `gasUsed` minus intrinsic calldata cost. Total gasUsed is
 *      not the right quantity: it includes 4 gas per zero calldata byte and 16
 *      per non-zero, and the caller's fresh ciphertext varies in zero-byte count
 *      for reasons unrelated to the outcome.
 *   2. THE FHE OPERATION SEQUENCE, counted from the executor's own events in the
 *      receipt. Evidence one layer below gas, at the FHE layer itself.
 *   3. HCU, from those measured op counts times the per-op costs read from
 *      HCULimit.sol. HCU is accumulated in transient storage with no event and no
 *      view, so it cannot be read back; only the prices come from source.
 *
 * Modes:
 *   (default)               round-robin across the three paths, GATE_ROUNDS times
 *   GATE_CONTROL=<label>    hammer one path, GATE_ROUNDS times
 *   GATE_DISTRIBUTION=1     GATE_SAMPLES sends on EACH path, then compare the
 *                           per-path execution-gas distributions
 *
 * The distribution mode is the one that closes the gate. Proving gas is not a
 * deterministic function of the path is not enough: a skewed distribution would
 * leak without being deterministic.
 *
 * Idempotent — deployments and funded actors are cached in .env.
 *
 *   pnpm spike:sepolia-gate
 */
import { ethers } from "hardhat";
import { Wallet, formatEther, parseEther } from "ethers";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

import { record, requireEnv, upsertEnv, withRetry } from "./_shared";

const ROUNDS = Number(process.env.GATE_ROUNDS ?? "3");
const SAMPLES = Number(process.env.GATE_SAMPLES ?? "20");
const DISTRIBUTION = process.env.GATE_DISTRIBUTION === "1";
const FUND_TARGET = parseEther("0.05");
const AMOUNT = 500n;
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

/**
 * Chi-square over an r x c contingency table. Used to ask whether the per-path
 * execution-gas distributions are distinguishable. A large statistic relative to
 * the critical value means the path predicts the gas, which would be a leak.
 */
function chiSquare(table: number[][]): { stat: number; df: number } {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  const rowSum = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colSum = Array.from({ length: cols }, (_, j) => table.reduce((a, r) => a + (r[j] ?? 0), 0));
  const n = rowSum.reduce((a, b) => a + b, 0);
  let stat = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const exp = ((rowSum[i] ?? 0) * (colSum[j] ?? 0)) / n;
      if (exp > 0) stat += ((table[i]?.[j] ?? 0) - exp) ** 2 / exp;
    }
  }
  return { stat, df: (rows - 1) * (cols - 1) };
}

/**
 * Empirical mutual information in bits between the path and the observed gas.
 * Zero means an observation of gas tells you nothing about which path ran.
 */
function mutualInformation(table: number[][]): number {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  const n = table.reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0);
  const rowSum = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colSum = Array.from({ length: cols }, (_, j) => table.reduce((a, r) => a + (r[j] ?? 0), 0));
  let mi = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const pij = (table[i]?.[j] ?? 0) / n;
      if (pij === 0) continue;
      const pi = (rowSum[i] ?? 0) / n;
      const pj = (colSum[j] ?? 0) / n;
      mi += pij * Math.log2(pij / (pi * pj));
    }
  }
  return mi;
}

interface Sample {
  readonly label: string;
  readonly total: bigint;
  readonly cd: number;
  readonly zeros: number;
  readonly exec: bigint;
  readonly ops: string;
  readonly hcu: number;
  readonly tx: string;
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

  for (const w of [...owners, ...keys]) {
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < FUND_TARGET / 2n) {
      await (await deployer.sendTransaction({ to: w.address, value: FUND_TARGET })).wait();
      console.log(`funded  ${w.address}  ${formatEther(FUND_TARGET)} ETH`);
    }
  }

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

  const expiry = Math.floor(Date.now() / 1000) + 30 * DAY;

  if ((await token.confidentialBalanceOf(recipient.address)) === ethers.ZeroHash) {
    await (await token.connect(deployer).mintPlain(recipient.address, 1n)).wait();
    console.log("warmed recipient");
  }

  for (let i = 0; i < 3; i++) {
    const owner = owners[i]!;
    const key = keys[i]!;
    const setup = SETUPS[i]!;

    if ((await module.sessionOf(key.address)).owner !== ethers.ZeroAddress) continue;

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
    console.log(`opened session ${i} (${setup.label})`);
  }

  // The success path must stay successful for the whole run, so top up both the
  // budget and the holder's balance to cover every sample with headroom.
  if (DISTRIBUTION) {
    const need = AMOUNT * BigInt(SAMPLES + 4);
    const owner = owners[0]!;
    const key = keys[0]!;
    await (await token.connect(deployer).mintPlain(owner.address, need)).wait();
    const top = await instance
      .createEncryptedInput(moduleAddr, owner.address)
      .add64(need)
      .encrypt();
    await (
      await module
        .connect(owner)
        .increaseBudget(key.address, tokenAddr, top.handles[0]!, top.inputProof)
    ).wait();
    console.log(`topped up the success path by ${need} for ${SAMPLES} samples\n`);
  }

  // Only the Interface is needed: every log is tried and non-matching ones skipped.
  const iface = new ethers.Interface(EXECUTOR_ABI);

  async function sendOnce(i: number): Promise<Sample> {
    const key = keys[i]!;
    const enc = await withRetry(`encrypt ${SETUPS[i]!.label}`, () =>
      instance.createEncryptedInput(moduleAddr, key.address).add64(AMOUNT).encrypt(),
    );
    const tx = await withRetry(`send ${SETUPS[i]!.label}`, () =>
      module.connect(key).send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
    );
    const receipt = await withRetry("mine", () => tx.wait());
    const sentTx = await ethers.provider.getTransaction(tx.hash);
    const cd = calldataGas(sentTx!.data);

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
      const cost = HCU[parsed.name];
      if (cost === undefined) continue;
      counts[parsed.name] = (counts[parsed.name] ?? 0) + 1;
      const scalarByte = parsed.args["scalarByte"] as string | undefined;
      hcu += scalarByte !== undefined && scalarByte !== "0x00" ? cost.scalar : cost.cipher;
    }
    return {
      label: SETUPS[i]!.label,
      total: receipt!.gasUsed,
      cd: cd.gas,
      zeros: cd.zeros,
      exec: receipt!.gasUsed - BigInt(cd.gas),
      ops: Object.keys(counts)
        .sort()
        .map((k) => `${k}x${counts[k]}`)
        .join(" "),
      hcu,
      tx: tx.hash,
    };
  }

  const samples: Sample[] = [];

  if (DISTRIBUTION) {
    for (let i = 0; i < 3; i++) {
      process.stdout.write(`  ${SETUPS[i]!.label.padEnd(14)} `);
      for (let n = 0; n < SAMPLES; n++) {
        const s = await sendOnce(i);
        samples.push(s);
        process.stdout.write(s.exec === 891572n ? "." : "x");
      }
      process.stdout.write("\n");
    }
  } else {
    const control = process.env.GATE_CONTROL;
    const only = control === undefined ? null : SETUPS.findIndex((s) => s.label === control);
    if (only === -1) throw new Error(`unknown GATE_CONTROL path: ${control}`);
    for (let round = 1; round <= ROUNDS; round++) {
      for (let i = 0; i < 3; i++) {
        if (only !== null && i !== only) continue;
        const s = await sendOnce(i);
        samples.push(s);
        console.log(`round ${round}  ${s.label.padEnd(14)} exec ${s.exec}  hcu ${s.hcu}`);
      }
    }
  }

  // ---- report ---------------------------------------------------------------
  const execValues = [...new Set(samples.map((s) => s.exec.toString()))].sort();
  const opSeqs = [...new Set(samples.map((s) => s.ops))];
  const hcus = [...new Set(samples.map((s) => s.hcu))];

  console.log("\n  EXECUTION-GAS DISTRIBUTION BY PATH\n");
  console.log(`  path             n   ${execValues.map((v) => v.padStart(9)).join("  ")}`);
  const table: number[][] = [];
  for (const setup of SETUPS) {
    const mine = samples.filter((s) => s.label === setup.label);
    if (mine.length === 0) continue;
    const row = execValues.map((v) => mine.filter((s) => s.exec.toString() === v).length);
    table.push(row);
    console.log(
      `  ${setup.label.padEnd(15)} ${String(mine.length).padStart(2)}   ` +
        row.map((c) => String(c).padStart(9)).join("  "),
    );
  }

  let chi = { stat: 0, df: 0 };
  let mi = 0;
  if (table.length > 1 && execValues.length > 1) {
    chi = chiSquare(table);
    mi = mutualInformation(table);
    // df=2 -> 5.991 at p=0.05; df=1 -> 3.841. Above it, the path predicts the gas.
    const crit = chi.df === 1 ? 3.841 : chi.df === 2 ? 5.991 : 7.815;
    console.log(
      `\n  chi-square ${chi.stat.toFixed(3)} on ${chi.df} df (critical ${crit} at p=0.05) -> ` +
        `${chi.stat > crit ? "DISTRIBUTIONS DIFFER" : "not distinguishable"}`,
    );
    console.log(`  mutual information path <-> gas : ${mi.toFixed(5)} bits per observation`);
  }

  console.log(`\n  distinct FHE op sequences : ${opSeqs.length}`);
  for (const o of opSeqs) console.log(`    ${o}`);
  console.log(`  distinct HCU values       : ${hcus.length}  ${hcus.join(", ")}`);

  const out = record(DISTRIBUTION ? "sepolia-distribution" : "sepolia-equality", {
    network: "sepolia",
    module: moduleAddr,
    token: tokenAddr,
    mode: DISTRIBUTION ? "distribution" : (process.env.GATE_CONTROL ?? "round-robin"),
    samplesPerPath: DISTRIBUTION ? SAMPLES : undefined,
    execValues,
    table,
    chiSquare: chi,
    mutualInformationBits: mi,
    distinctOpSequences: opSeqs,
    distinctHCU: hcus,
    samples: samples.map((s) => ({ ...s, total: s.total.toString(), exec: s.exec.toString() })),
  });
  console.log(`\n  recorded -> ${out}`);

  // ---- criterion (b) --------------------------------------------------------
  // Hard equality on the two quantities that describe the computation; a bounded,
  // explained residual on EVM gas, with the distributions required to be
  // indistinguishable rather than merely non-deterministic.
  const failures: string[] = [];
  if (opSeqs.length !== 1) failures.push("FHE operation sequence differs across paths");
  if (hcus.length !== 1) failures.push(`HCU differs across paths: ${hcus.join(", ")}`);
  const spread =
    execValues.length === 0
      ? 0n
      : BigInt(execValues[execValues.length - 1]!) - BigInt(execValues[0]!);
  if (spread > 4n) failures.push(`execution-gas spread ${spread} exceeds the 4 gas bound`);
  if (table.length > 1 && execValues.length > 1) {
    const crit = chi.df === 1 ? 3.841 : chi.df === 2 ? 5.991 : 7.815;
    if (chi.stat > crit)
      failures.push(`execution-gas distributions differ by path (chi2 ${chi.stat.toFixed(3)})`);
  }
  for (const s of samples) {
    if (s.total - BigInt(s.cd) !== s.exec) failures.push(`attribution does not close on ${s.tx}`);
  }

  if (failures.length > 0) {
    console.log("\n  GATE FAILED");
    for (const f of failures) console.log(`    - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n  GATE PASSED");
  console.log("    FHE operation sequence : identical on every path");
  console.log("    HCU                    : identical on every path");
  console.log(`    execution gas          : spread ${spread}, distributions not distinguishable`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
