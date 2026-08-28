/**
 * GhostPool step-1 spike: what a draw and a claim actually cost.
 *
 * Two questions, in priority order:
 *
 *   1. The claim path of the independent-threshold design — measured HCU, and
 *      whether a winner and a loser burn identical gas. If they do not, the
 *      "only the winner learns the outcome" claim dies on the cheapest possible
 *      observation, and no amount of encryption saves it.
 *
 *   2. The prefix designs, naive vs incremental, swept over N to find the
 *      ceiling empirically rather than inferring it from the cost table.
 *
 * Method carried from GhostKey's docs/leakage.md, which established two things
 * the hard way:
 *
 *   - HCU is accumulated in transient storage with no event, so it cannot be
 *     read back. It is reconstructed by counting the coprocessor's per-op events
 *     and multiplying by the costs read from HCULimit.sol.
 *   - Total gasUsed includes intrinsic calldata cost, and comparing it across
 *     arms measures the calldata, not the computation. Execution gas is the
 *     quantity that means anything.
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Per-op HCU for euint64, read from HCULimit.sol (@fhevm/host-contracts 0.10.0).
// gt scalar is 117,000 — the 116,000 in GhostKey's table is ge, a different branch.
const HCU: Record<string, { scalar: number; cipher: number }> = {
  FheAdd: { scalar: 133_000, cipher: 162_000 },
  FheSub: { scalar: 133_000, cipher: 162_000 },
  FheGe: { scalar: 116_000, cipher: 152_000 },
  FheGt: { scalar: 117_000, cipher: 152_000 },
  FheLe: { scalar: 119_000, cipher: 149_000 },
  FheLt: { scalar: 119_000, cipher: 149_000 },
  FheBitAnd: { scalar: 22_000, cipher: 22_000 },
  FheIfThenElse: { scalar: 55_000, cipher: 55_000 },
  FheRem: { scalar: 1_153_000, cipher: 1_153_000 },
  FheRand: { scalar: 24_000, cipher: 24_000 },
  FheRandBounded: { scalar: 24_000, cipher: 24_000 },
  TrivialEncrypt: { scalar: 32, cipher: 32 },
};

const EXECUTOR_ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheRem(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheBitAnd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event FheRand(address indexed caller, uint8 randType, bytes16 seed, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
];

/** Intrinsic calldata cost under EIP-2028. */
function calldataGas(data: string): number {
  const bytes = ethers.getBytes(data);
  let zeros = 0;
  for (const b of bytes) if (b === 0) zeros++;
  return zeros * 4 + (bytes.length - zeros) * 16;
}

interface Measured {
  readonly total: bigint;
  readonly exec: bigint;
  readonly hcu: number;
  readonly ops: string;
  readonly tx: string;
}

const iface = new ethers.Interface(EXECUTOR_ABI);

async function measure(tx: { hash: string; wait: () => Promise<unknown> }): Promise<Measured> {
  const receipt = (await tx.wait()) as { gasUsed: bigint; logs: readonly unknown[] };
  const sent = await ethers.provider.getTransaction(tx.hash);
  const cd = calldataGas(sent!.data);

  const counts: Record<string, number> = {};
  let hcu = 0;
  for (const log of receipt.logs as { topics: string[]; data: string }[]) {
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
    const sb = parsed.args["scalarByte"] as string | undefined;
    hcu += sb !== undefined && sb !== "0x00" ? cost.scalar : cost.cipher;
  }

  return {
    total: receipt.gasUsed,
    exec: receipt.gasUsed - BigInt(cd),
    hcu,
    ops: Object.keys(counts)
      .sort()
      .map((k) => `${k}x${counts[k]}`)
      .join(" "),
    tx: tx.hash,
  };
}

/** JSON.stringify refuses BigInt outright, and gas values are BigInt. */
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const OUT = path.join(__dirname, "..", "out");
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const THRESHOLD = 100n;
const PRIZE = 777n;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const bal = await ethers.provider.getBalance(me);
  console.log(`signer ${me}  ${ethers.formatEther(bal)} ETH\n`);

  const Factory = await ethers.getContractFactory("DrawSpike");
  const spike = await Factory.deploy();
  await spike.waitForDeployment();
  const addr = await spike.getAddress();
  console.log(`DrawSpike ${addr}\n`);

  const results: Record<string, unknown> = { contract: addr, signer: me };

  // =========================================================================
  // Part 1 — the claim path, and whether winning is observable
  //
  // Same sender, same calldata, same threshold. The only thing that differs
  // between the two arms is the encrypted weight, which is exactly the secret
  // that must not leak. Arms are interleaved so any drift over time hits both.
  //
  // The first claim is discarded: it writes _credit from zero, and a cold slot
  // costs 20,000 gas against 2,900 for a warm one. That difference has nothing
  // to do with the secret, and leaving it in would swamp the measurement.
  // =========================================================================
  console.log("--- part 1: claim path ---");

  const encWin = await fhevm.createEncryptedInput(addr, me).add64(1000n).encrypt();
  const encLose = await fhevm.createEncryptedInput(addr, me).add64(10n).encrypt();
  console.log("weights encrypted: 1000 (wins vs threshold 100), 10 (loses)");

  const setW = async (e: { handles: Uint8Array[]; inputProof: Uint8Array }) => {
    const t = await spike.setWeight(e.handles[0]!, e.inputProof);
    await t.wait();
  };

  await setW(encWin);
  const warm = await spike.claimThreshold(THRESHOLD, PRIZE);
  await warm.wait();
  console.log("warm-up claim done (discarded)\n");

  const claims: { arm: string; m: Measured }[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const [arm, enc] of [
      ["winner", encWin],
      ["loser", encLose],
    ] as const) {
      await setW(enc);
      const m = await measure(await spike.claimThreshold(THRESHOLD, PRIZE));
      claims.push({ arm, m });
      console.log(
        `  r${String(r).padStart(2)} ${arm.padEnd(7)} exec ${m.exec}  hcu ${m.hcu}  ${m.ops}`,
      );
    }
  }

  const summarise = (arm: string) => {
    const xs = claims.filter((c) => c.arm === arm).map((c) => c.m);
    return {
      arm,
      n: xs.length,
      execValues: [...new Set(xs.map((x) => x.exec.toString()))],
      hcuValues: [...new Set(xs.map((x) => x.hcu))],
      opSequences: [...new Set(xs.map((x) => x.ops))],
    };
  };
  const win = summarise("winner");
  const lose = summarise("loser");

  console.log(`\n  winner  exec ${win.execValues.join(", ")}  hcu ${win.hcuValues.join(", ")}`);
  console.log(`  loser   exec ${lose.execValues.join(", ")}  hcu ${lose.hcuValues.join(", ")}`);
  const identical =
    JSON.stringify(win.execValues) === JSON.stringify(lose.execValues) &&
    JSON.stringify(win.hcuValues) === JSON.stringify(lose.hcuValues) &&
    JSON.stringify(win.opSequences) === JSON.stringify(lose.opSequences);
  console.log(`  VERDICT ${identical ? "indistinguishable on all three" : "A DIFFERENCE EXISTS"}\n`);

  results["claim"] = { rounds: ROUNDS, winner: win, loser: lose, identical, samples: claims };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "draw-hcu.json"), JSON.stringify(results, bigintSafe, 2));

  // =========================================================================
  // Part 2 — the prefix designs, swept over N
  // =========================================================================
  console.log("--- part 2: prefix designs ---");

  const NS = (process.env.NS ?? "5,10,20,40,80").split(",").map(Number);
  const maxN = Math.max(...NS);
  const weights: bigint[] = [];
  const cumulative: bigint[] = [0n];
  for (let i = 0; i < maxN; i++) {
    weights.push(BigInt(100 + i));
    cumulative.push(cumulative[i]! + BigInt(100 + i));
  }
  const total = cumulative[maxN]!;

  // Seeding is setup, not measurement. Chunked to stay inside the per-tx limit.
  const CHUNK = 20;
  for (let i = 0; i < maxN; i += CHUNK) {
    const t = await spike.seedWeights(weights.slice(i, i + CHUNK));
    await t.wait();
  }
  for (let i = 0; i < cumulative.length; i += CHUNK) {
    const t = await spike.seedPrefix(cumulative.slice(i, i + CHUNK));
    await t.wait();
  }
  const [wLen, pLen] = await spike.sizes();
  console.log(`seeded weights=${wLen} prefix=${pLen} total=${total}\n`);

  const sweep: Record<string, unknown>[] = [];
  for (const n of NS) {
    for (const design of ["naive", "incremental", "incremental+credit"] as const) {
      try {
        const call =
          design === "naive"
            ? spike.drawNaive(n, total)
            : design === "incremental"
              ? spike.drawIncremental(n, total)
              : spike.drawIncrementalWithCredit(n, total, PRIZE);
        const m = await measure(await call);
        console.log(`  N=${String(n).padStart(3)} ${design.padEnd(19)} hcu ${m.hcu}  exec ${m.exec}`);
        sweep.push({ n, design, hcu: m.hcu, exec: m.exec.toString(), ops: m.ops, tx: m.tx });
      } catch (e) {
        const msg = (e as Error).message.slice(0, 140);
        console.log(`  N=${String(n).padStart(3)} ${design.padEnd(19)} FAILED  ${msg}`);
        sweep.push({ n, design, failed: msg });
      }
    }
  }

  results["sweep"] = sweep;
  fs.writeFileSync(path.join(OUT, "draw-hcu.json"), JSON.stringify(results, bigintSafe, 2));
  console.log(`\nwritten to out/draw-hcu.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
