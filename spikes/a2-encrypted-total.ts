/**
 * A2 — what it costs to keep the aggregate encrypted.
 *
 *   npx hardhat run spikes/a2-encrypted-total.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
const EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";
const ABI = [
  "event FheMul(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheShr(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, bytes1 toType, bytes32 result)",
  "event Cast(address indexed caller, bytes32 ct, bytes1 toType, bytes32 result)",
];
const COST: Record<string, Record<string, number>> = {
  "FheMul.u128.scalar": { x: 696000 }, "FheMul.u128": { x: 1686000 },
  "FheShr.u128.scalar": { x: 37000 }, "FheShr.u128": { x: 272000 },
  "FheGt.u128.scalar": { x: 150000 }, "FheGt.u128": { x: 210000 },
  "FheIfThenElse.u64": { x: 55000 }, "TrivialEncrypt.u64": { x: 32 },
  "TrivialEncrypt.u128": { x: 32 }, "Cast.u64": { x: 32 }, "Cast.u128": { x: 32 },
};
const T: Record<number, string> = { 0: "bool", 5: "u64", 6: "u128" };
const w = (h: string): string => T[parseInt(h.slice(-4, -2), 16)] ?? "?";

async function price(hash: string): Promise<void> {
  const iface = new ethers.Interface(ABI);
  const rc = await ethers.provider.getTransactionReceipt(hash);
  let total = 0;
  const by = new Map<string, number>();
  for (const l of rc!.logs) {
    if (l.address.toLowerCase() !== EXECUTOR.toLowerCase()) continue;
    let p; try { p = iface.parseLog({ topics: [...l.topics], data: l.data }); } catch { continue; }
    if (p === null) continue;
    const cmp = p.name === "FheGt";
    const width = w((cmp ? p.args["lhs"] : p.args["result"]) as string);
    const sb = p.args["scalarByte"] as string | undefined;
    const key = `${p.name}.${width}${sb !== undefined && sb !== "0x00" ? ".scalar" : ""}`;
    const c = COST[key]?.["x"] ?? 0;
    total += c;
    by.set(key, (by.get(key) ?? 0) + c);
  }
  console.log(`    gas ${rc!.gasUsed}   HCU ${total.toLocaleString()}`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(24)} ${v.toLocaleString()}`);
  console.log(`\n  projected onto production accrue (3,537,224 cold, flat check is 205,000):`);
  const projected = 3_537_224 - 205_000 + total;
  console.log(`    ${projected.toLocaleString()} HCU/accrual  ->  ${Math.floor(20_000_000 / projected)} cold accruals per tx`);
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const Spike = await ethers.getContractFactory("TieredAccrualSpike");
  const spike = await Spike.deploy(); await spike.waitForDeployment();
  const addr = await spike.getAddress();
  console.log(`spike ${addr}`);
  const TOTAL = 1_000_000_000n;
  await (await spike.seed!(123456789n, TOTAL)).wait();
  let e = await fhevm.createEncryptedInput(addr, me).add128(TOTAL).encrypt();
  await (await spike.setWeight!(e.handles[0], e.inputProof)).wait();
  e = await fhevm.createEncryptedInput(addr, me).add128(TOTAL).encrypt();
  await (await spike.setTotal!(e.handles[0], e.inputProof)).wait();
  const enc = await spike.encTotal!();
  console.log(`\n  encrypted-aggregate comparison`);
  const rc = await (await spike.accrueEncryptedTotal!(me, enc, 123456789n, 1_000_000n)).wait();
  await price(rc!.hash);
}
main().catch((e) => { console.error(String(e).split("\n").slice(0, 4).join("\n")); process.exitCode = 1; });
