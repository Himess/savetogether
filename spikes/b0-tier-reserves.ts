/** B0 — what per-tier reserves cost on top of tiers. */
import { ethers, fhevm } from "hardhat";
const EXECUTOR = "0x92C920834Ec8941d2C77D188936E1f7A6f49c127";
const ABI = [
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, bytes1 toType, bytes32 result)",
];
const C: Record<string, number> = {
  "FheSub.u64": 162000, "FheSub.u64.scalar": 133000,
  "FheGe.u64": 116000, "FheGe.u64.scalar": 116000,
  "FheGt.u128.scalar": 150000, "FheGt.u128": 210000,
  "FheIfThenElse.u64": 55000, "TrivialEncrypt.u64": 32, "TrivialEncrypt.u128": 32,
};
const T: Record<number, string> = { 0: "bool", 5: "u64", 6: "u128" };
const wd = (h: string): string => T[parseInt(h.slice(-4, -2), 16)] ?? "?";
async function price(hash: string): Promise<number> {
  const iface = new ethers.Interface(ABI);
  const rc = await ethers.provider.getTransactionReceipt(hash);
  let total = 0; const by = new Map<string, number>();
  for (const l of rc!.logs) {
    if (l.address.toLowerCase() !== EXECUTOR.toLowerCase()) continue;
    let p; try { p = iface.parseLog({ topics: [...l.topics], data: l.data }); } catch { continue; }
    if (p === null) continue;
    const cmp = p.name === "FheGt" || p.name === "FheGe";
    const width = wd((cmp ? p.args["lhs"] : p.args["result"]) as string);
    const sb = p.args["scalarByte"] as string | undefined;
    const key = `${p.name}.${width}${sb !== undefined && sb !== "0x00" ? ".scalar" : ""}`;
    const c = C[key] ?? 0; total += c; by.set(key, (by.get(key) ?? 0) + c);
  }
  console.log(`    gas ${rc!.gasUsed}   HCU ${total.toLocaleString()}`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(24)} ${v.toLocaleString()}`);
  return total;
}
async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const Spike = await ethers.getContractFactory("TieredAccrualSpike");
  const spike = await Spike.deploy(); await spike.waitForDeployment();
  const addr = await spike.getAddress();
  const TOTAL = 1_000_000_000n;
  await (await spike.seed!(123456789n, TOTAL)).wait();
  let e = await fhevm.createEncryptedInput(addr, me).add128(TOTAL).encrypt();
  await (await spike.setWeight!(e.handles[0], e.inputProof)).wait();
  e = await fhevm.createEncryptedInput(addr, me).add64(1_000_000_000n).encrypt();
  await (await spike.seedTierReserves!(e.handles[0], e.inputProof, 3)).wait();

  const prizes = [50_000_000n, 10_000_000n, 2_000_000n];
  const k = [100n, 10n, 1n];
  console.log(`\n  3 tiers, ONE reserve (the A1 shape)`);
  const a = await (await spike.accrueTiered!(me, prizes, k)).wait();
  const one = await price(a!.hash);
  console.log(`\n  3 tiers, PER-TIER reserves`);
  const b = await (await spike.accrueTieredWithReserves!(me, prizes, k)).wait();
  const per = await price(b!.hash);

  const BASE = 3_537_224, FLAT = 205_000, CEIL = 20_000_000;
  console.log(`\n  projected onto production accrue (${BASE.toLocaleString()} cold, flat check ${FLAT.toLocaleString()}):`);
  for (const [label, hcu] of [["3 tiers, one reserve", one], ["3 tiers, per-tier reserves", per]] as [string, number][]) {
    const p = BASE - FLAT + hcu;
    console.log(`    ${label.padEnd(28)} ${p.toLocaleString()} HCU  ->  ${Math.floor(CEIL / p)} cold accruals/tx`);
  }
}
main().catch((e) => { console.error(String(e).split("\n").slice(0, 4).join("\n")); process.exitCode = 1; });
