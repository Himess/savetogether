/**
 * A1 — the real HCU cost of encrypted prize tiers.
 *
 * Runs flat/2/3/4-tier accrual on Sepolia, then re-reads each receipt and prices
 * the FHEVMExecutor events against HCULimit.sol. Same method that produced the
 * production accrue figures, so the numbers are comparable rather than merely
 * adjacent.
 *
 *   npx hardhat run spikes/a1-tier-hcu.ts --network sepolia
 *
 * STOP THE KEEPER FIRST — same signing key.
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";

const EVENT_ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheMul(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheDiv(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheShr(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheEq(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheNe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheNot(address indexed caller, bytes32 ct, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event Cast(address indexed caller, bytes32 ct, bytes1 toType, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, bytes1 toType, bytes32 result)",
  "event FheRand(address indexed caller, bytes1 randType, bytes16 seed, bytes32 result)",
  "event VerifyCiphertext(address indexed caller, bytes32 inputHandle, address userAddress, bytes inputProof, bytes1 inputType, bytes32 result)",
];

/** HCU per operation, from HCULimit.sol (@fhevm/host-contracts 0.10.0). */
const HCU: Record<string, { scalar?: Record<string, number>; nonScalar?: Record<string, number> }> = {
  FheAdd: { scalar: { u64: 133000, u128: 172000 }, nonScalar: { u64: 162000, u128: 259000 } },
  FheSub: { scalar: { u64: 133000, u128: 172000 }, nonScalar: { u64: 162000, u128: 260000 } },
  FheMul: { scalar: { u64: 365000, u128: 696000 }, nonScalar: { u64: 596000, u128: 1686000 } },
  FheDiv: { scalar: { u64: 715000, u128: 1225000 } },
  FheShr: { scalar: { u64: 34000, u128: 37000 }, nonScalar: { u64: 209000, u128: 272000 } },
  FheGe: { scalar: { u64: 116000, u128: 150000 }, nonScalar: { u64: 152000, u128: 210000 } },
  FheGt: { scalar: { u64: 116000, u128: 150000 }, nonScalar: { u64: 152000, u128: 210000 } },
  FheLe: { scalar: { u64: 116000, u128: 150000 }, nonScalar: { u64: 152000, u128: 210000 } },
  FheLt: { scalar: { u64: 116000, u128: 150000 }, nonScalar: { u64: 152000, u128: 210000 } },
  FheEq: { scalar: { u64: 51000, u128: 100000, bool: 26000 }, nonScalar: { u64: 55000, u128: 100000, bool: 44000 } },
  FheNe: { scalar: { u64: 51000, u128: 100000, bool: 26000 }, nonScalar: { u64: 55000, u128: 100000, bool: 44000 } },
  FheNot: { nonScalar: { bool: 30000, u64: 33000, u128: 36000 } },
  FheIfThenElse: { nonScalar: { u64: 55000, u128: 57000, bool: 55000 } },
  Cast: { scalar: { u64: 32, u128: 32, bool: 32 }, nonScalar: { u64: 32, u128: 32, bool: 32 } },
  TrivialEncrypt: { scalar: { u64: 32, u128: 32, bool: 32 }, nonScalar: { u64: 32, u128: 32, bool: 32 } },
  FheRand: { nonScalar: { u64: 100000, u128: 100000, bool: 100000 } },
  VerifyCiphertext: { scalar: { u64: 0, u128: 0, bool: 0 }, nonScalar: { u64: 0, u128: 0, bool: 0 } },
};

const TYPE_NAME: Record<number, string> = { 0: "bool", 2: "u8", 3: "u16", 4: "u32", 5: "u64", 6: "u128" };

/** Handle byte -2 carries the FheType, so widths are read rather than inferred. */
function widthOf(handle: string): string {
  const b = parseInt(handle.slice(-4, -2), 16);
  return TYPE_NAME[b] ?? `t${b}`;
}

interface Row { op: string; width: string; scalar: boolean; hcu: number }

async function priceTx(hash: string): Promise<{ rows: Row[]; total: number; gas: bigint }> {
  const iface = new ethers.Interface(EVENT_ABI);
  const rc = await ethers.provider.getTransactionReceipt(hash);
  if (rc === null) throw new Error(`no receipt for ${hash}`);
  const rows: Row[] = [];
  const COMPARISON = new Set(["FheEq", "FheNe", "FheGe", "FheGt", "FheLe", "FheLt"]);
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== EXECUTOR.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed === null) continue;
    const name = parsed.name;
    const entry = HCU[name];
    if (entry === undefined) continue;
    // A comparison's cost follows its INPUT width; everything else its result.
    const widthSrc = COMPARISON.has(name)
      ? (parsed.args["lhs"] as string)
      : (parsed.args["result"] as string);
    const width = widthOf(widthSrc);
    const sb = parsed.args["scalarByte"] as string | undefined;
    const scalar = sb !== undefined && sb !== "0x00";
    const table = scalar ? (entry.scalar ?? entry.nonScalar) : (entry.nonScalar ?? entry.scalar);
    const hcu = table?.[width] ?? 0;
    rows.push({ op: name, width, scalar, hcu });
  }
  return { rows, total: rows.reduce((a, b) => a + b.hcu, 0), gas: rc.gasUsed };
}

function summarise(label: string, rows: Row[], total: number, gas: bigint): void {
  const by = new Map<string, { n: number; hcu: number }>();
  for (const r of rows) {
    const k = `${r.op}.${r.width}${r.scalar ? ".scalar" : ""}`;
    const cur = by.get(k) ?? { n: 0, hcu: 0 };
    by.set(k, { n: cur.n + 1, hcu: cur.hcu + r.hcu });
  }
  console.log(`\n  ${label}`);
  console.log(`    gas ${gas}   HCU ${total.toLocaleString()}   ops ${rows.length}`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1].hcu - a[1].hcu)) {
    console.log(`      ${k.padEnd(28)} x${String(v.n).padStart(2)}  ${v.hcu.toLocaleString()}`);
  }
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();

  const Spike = await ethers.getContractFactory("TieredAccrualSpike");
  const spike = await Spike.deploy();
  await spike.waitForDeployment();
  const addr = await spike.getAddress();
  console.log(`spike ${addr}`);

  const TOTAL = 1_000_000_000n;
  await (await spike.seed!(123456789n, TOTAL)).wait();

  // A weight big enough that every tier is won, so the select chain is fully
  // exercised rather than short-circuited. FHE has no branches, so this changes
  // nothing about cost — it only makes the result readable.
  const enc = await fhevm.createEncryptedInput(addr, me).add128(TOTAL).encrypt();
  await (await spike.setWeight!(enc.handles[0], enc.inputProof)).wait();

  const results: { label: string; tiers: number; hcu: number; gas: string }[] = [];

  const flat = await (await spike.accrueFlat!(me, 1_000_000n)).wait();
  const f = await priceTx(flat!.hash);
  summarise("flat (1 prize, the production shape)", f.rows, f.total, f.gas);
  results.push({ label: "flat", tiers: 1, hcu: f.total, gas: f.gas.toString() });

  for (const n of [2, 3, 4]) {
    const prizes = Array.from({ length: n }, (_, i) => BigInt(10_000_000 / 10 ** i));
    const k = Array.from({ length: n }, (_, i) => BigInt(10 ** (n - 1 - i)));
    const rc = await (await spike.accrueTiered!(me, prizes, k)).wait();
    const p = await priceTx(rc!.hash);
    summarise(`${n} tiers  k=[${k.join(", ")}]`, p.rows, p.total, p.gas);
    results.push({ label: `${n}-tier`, tiers: n, hcu: p.total, gas: p.gas.toString() });
  }

  // What the numbers mean for the keeper.
  const BASE_COLD = 3_537_224;
  const CEILING = 20_000_000;
  const flatHcu = results[0]!.hcu;
  console.log(`\n  ── what this does to the batch size ──`);
  console.log(`  production accrue, cold: ${BASE_COLD.toLocaleString()} HCU  (ceiling ${CEILING.toLocaleString()})`);
  for (const r of results) {
    const delta = r.hcu - flatHcu;
    const projected = BASE_COLD + delta;
    console.log(
      `  ${r.label.padEnd(7)} +${delta.toLocaleString().padStart(9)} over flat  ->  ` +
        `${projected.toLocaleString()} HCU/accrual  ->  ${Math.floor(CEILING / projected)} cold accruals per tx`,
    );
  }

  const out = path.join(__dirname, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "a1-tier-hcu.json"), JSON.stringify({ spike: addr, results }, null, 2));
  console.log(`\n  written to spikes/out/a1-tier-hcu.json`);
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 5).join("\n"));
  process.exitCode = 1;
});
