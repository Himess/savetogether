/**
 * R2, second half — which FHE operations each path actually performs.
 *
 * §11.1 attributed HCU by reading operations off the source, because "the
 * coprocessor's event does not carry the type". That is true of the event, but
 * the RESULT HANDLE carries it: byte -2 is the FheType (Bool 0, Uint8 2,
 * Uint16 3, Uint32 4, Uint64 5, Uint128 6). So the width can be measured here
 * rather than inferred, which removes the exact degree of freedom that let
 * §10.2's two errors cancel.
 *
 *   npx hardhat run spikes/r2-hcu.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";

/** Every operation event carries (caller, ...operands, scalarByte, result). */
const EVENT_ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheMul(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheDiv(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheShr(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheEq(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheNe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheNot(address indexed caller, bytes32 ct, bytes32 result)",
  "event FheNeg(address indexed caller, bytes32 ct, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event Cast(address indexed caller, bytes32 ct, uint8 toType, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
  "event VerifyInput(address indexed caller, bytes32 inputHandle, address userAddress, bytes inputProof, uint8 inputType, bytes32 result)",
];

const TYPE_NAME: Record<number, string> = {
  0: "bool",
  2: "u8",
  3: "u16",
  4: "u32",
  5: "u64",
  6: "u128",
};

/**
 * HCU per operation, read out of HCULimit.sol at the line named beside each.
 *
 * Transcribing this by hand went wrong three times on the first pass — `add`
 * and `sub` scalar were entered as 87,000 when they are 133,000, `ge` scalar as
 * 87,000 when it is 116,000, and `Cast`/`TrivialEncrypt` as 100-200 when both
 * are 32. None of those changed the verdict, which is exactly why they were
 * easy to miss, so every figure below has been re-read against its line.
 *
 * `VerifyInput` is absent on purpose: there is no `checkHCUForVerifyInput` in
 * HCULimit.sol at all. Verifying an input proof costs EVM gas and zero HCU.
 */
const HCU: Record<string, { scalar?: Record<string, number>; nonScalar?: Record<string, number>; line: string }> = {
  FheAdd: { scalar: { u64: 133000 }, nonScalar: { u64: 162000, u128: 259000 }, line: "HCULimit.sol:108/124" },
  FheSub: { scalar: { u64: 133000 }, nonScalar: { u64: 162000, u128: 260000 }, line: "HCULimit.sol:160/176" },
  FheMul: { scalar: { u64: 365000, u128: 696000 }, nonScalar: { u64: 596000, u128: 1686000 }, line: "HCULimit.sol:~215" },
  FheDiv: { scalar: { u64: 715000, u128: 1225000 }, line: "HCULimit.sol:263" },
  FheShr: { scalar: { u64: 34000, u128: 37000 }, nonScalar: { u64: 209000, u128: 272000 }, line: "HCULimit.sol:568/586" },
  FheGe: { scalar: { u64: 116000 }, nonScalar: { u64: 152000 }, line: "HCULimit.sol:864/880" },
  FheGt: { scalar: { u64: 116000 }, nonScalar: { u64: 152000 }, line: "HCULimit.sol:~900" },
  FheNe: { scalar: { u64: 51000, bool: 26000 }, nonScalar: { u64: 55000, bool: 44000 }, line: "HCULimit.sol:~360" },
  FheIfThenElse: { nonScalar: { u64: 55000, u128: 57000, bool: 55000 }, line: "HCULimit.sol:1288" },
  Cast: { scalar: { u64: 32, u128: 32, bool: 32 }, nonScalar: { u64: 32, u128: 32, bool: 32 }, line: "HCULimit.sol:1222" },
  TrivialEncrypt: { scalar: { u64: 32, u128: 32, bool: 32 }, nonScalar: { u64: 32, u128: 32, bool: 32 }, line: "HCULimit.sol:1250" },
  VerifyInput: { scalar: { u64: 0, bool: 0 }, nonScalar: { u64: 0, bool: 0 }, line: "not metered" },
};

async function main(): Promise<void> {
  const file = path.join(__dirname, "out", "r2-plaintext-free.json");
  const measured = JSON.parse(fs.readFileSync(file, "utf8")) as {
    spike: string;
    rows: { path: string; what: string; gas: string; hashes: string[] }[];
  };

  const iface = new ethers.Interface(EVENT_ABI);
  const provider = ethers.provider;

  // Re-read the four transactions from the chain rather than trusting a cache.
  const spike = measured.spike;
  console.log(`spike ${spike}\n`);

  const wanted = new Map<string, string>();
  for (const r of measured.rows) for (const h of r.hashes) wanted.set(h.toLowerCase(), r.path);
  const logs = [];
  for (const h of wanted.keys()) {
    const rc = await provider.getTransactionReceipt(h);
    if (rc === null) continue;
    for (const l of rc.logs) if (l.address.toLowerCase() === EXECUTOR.toLowerCase()) logs.push(l);
  }

  const byTx = new Map<string, { name: string; type: string; scalar: boolean }[]>();
  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed === null) continue;
    const result = parsed.args["result"] as string;
    const COMPARISON = new Set(["FheEq", "FheNe", "FheGe", "FheGt", "FheLe", "FheLt"]);
    const widthFrom = COMPARISON.has(parsed.name) ? (parsed.args["lhs"] as string) : result;
    const typeByte = parseInt(widthFrom.slice(-4, -2), 16);
    const scalarArg = parsed.args["scalarByte"] as string | undefined;
    const entry = {
      name: parsed.name,
      type: TYPE_NAME[typeByte] ?? `type${typeByte}`,
      scalar: scalarArg === "0x01",
    };
    const list = byTx.get(log.transactionHash) ?? [];
    list.push(entry);
    byTx.set(log.transactionHash, list);
  }

  console.log("Operations per transaction, widths read from the result handle:\n");
  const summary: Record<string, unknown>[] = [];
  for (const [tx, ops] of byTx) {
    if (ops.length === 0) continue;
    let total = 0;
    let unpriced = 0;
    const counts = new Map<string, number>();
    for (const op of ops) {
      const key = `${op.name}.${op.type}${op.scalar ? " scalar" : ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const table = HCU[op.name];
      const price = table === undefined
        ? undefined
        : op.scalar
          ? table.scalar?.[op.type]
          : (table.nonScalar?.[op.type] ?? table.scalar?.[op.type]);
      if (price === undefined) unpriced += 1;
      else total += price;
    }
    console.log(`  ${wanted.get(tx.toLowerCase()) ?? "?"}  ${tx}`);
    console.log(`    ${ops.length} ops, HCU ${total.toLocaleString()}${unpriced > 0 ? `  (${unpriced} unpriced)` : ""}`);
    for (const [k, n] of [...counts].sort()) console.log(`      ${String(n).padStart(2)} x ${k}`);
    console.log("");
    summary.push({ path: wanted.get(tx.toLowerCase()), tx, ops: ops.length, hcu: total, unpriced, counts: Object.fromEntries(counts) });
  }

  fs.writeFileSync(
    path.join(__dirname, "out", "r2-hcu.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log("written to spikes/out/r2-hcu.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
