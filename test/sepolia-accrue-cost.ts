/**
 * What `accrue` actually costs, measured.
 *
 * findings.md §5.3 first put this at 172,064 HCU and about 116 users per
 * transaction. That was wrong by fourteen times, because 172,064 was the cost of
 * a bare comparison against a weight already sitting in storage — the real
 * function has to compute the weight out of the TWAB record first, and that is
 * where the cost lives. §10.2 corrected it to a COMPUTED 2,374,128.
 *
 * Computed is not measured, and the rule that caught the original error is that a
 * load-bearing number gets measured. This measures it, cold cache and warm, on
 * live Sepolia against the real coprocessor.
 *
 *   npx hardhat test test/sepolia-accrue-cost.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Per-op HCU read from HCULimit.sol (@fhevm/host-contracts 0.10.0). The step-1
// spike validated this table to the unit for add, le, gt, select and rem.
const HCU: Record<string, { scalar: number; cipher: number }> = {
  FheAdd: { scalar: 133_000, cipher: 162_000 },
  FheSub: { scalar: 133_000, cipher: 162_000 },
  FheMul: { scalar: 365_000, cipher: 596_000 },
  FheGe: { scalar: 116_000, cipher: 152_000 },
  FheGt: { scalar: 117_000, cipher: 152_000 },
  FheLe: { scalar: 119_000, cipher: 149_000 },
  FheLt: { scalar: 119_000, cipher: 149_000 },
  FheBitAnd: { scalar: 22_000, cipher: 22_000 },
  FheIfThenElse: { scalar: 55_000, cipher: 55_000 },
  FheRand: { scalar: 24_000, cipher: 24_000 },
  TrivialEncrypt: { scalar: 32, cipher: 32 },
  Cast: { scalar: 32, cipher: 32 },
};

// euint128 costs differ from euint64 and the event does not carry the width, so
// the reconstruction below is a lower bound wherever a 128-bit op is involved.
// The measured EVM gas is exact regardless; only the HCU attribution is coarse.
const HCU_128: Record<string, number> = {
  FheAdd: 259_000,
  FheSub: 260_000,
  FheMul: 696_000,
  FheGt: 150_000,
  FheIfThenElse: 57_000,
};

const ABI = [
  "event FheAdd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheSub(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheMul(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheGt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLe(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheLt(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheBitAnd(address indexed caller, bytes32 lhs, bytes32 rhs, bytes1 scalarByte, bytes32 result)",
  "event FheIfThenElse(address indexed caller, bytes32 control, bytes32 ifTrue, bytes32 ifFalse, bytes32 result)",
  "event FheRand(address indexed caller, uint8 randType, bytes16 seed, bytes32 result)",
  "event TrivialEncrypt(address indexed caller, uint256 pt, uint8 toType, bytes32 result)",
  "event Cast(address indexed caller, bytes32 ct, uint8 toType, bytes32 result)",
];

const iface = new ethers.Interface(ABI);

function analyse(logs: readonly { topics: string[]; data: string }[]) {
  const counts: Record<string, number> = {};
  let lower = 0;
  let upper = 0;
  for (const log of logs) {
    let p;
    try {
      p = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (p === null) continue;
    const c = HCU[p.name];
    if (c === undefined) continue;
    counts[p.name] = (counts[p.name] ?? 0) + 1;
    const sb = p.args["scalarByte"] as string | undefined;
    const at64 = sb !== undefined && sb !== "0x00" ? c.scalar : c.cipher;
    lower += at64;
    upper += HCU_128[p.name] ?? at64;
  }
  return {
    ops: Object.keys(counts)
      .sort()
      .map((k) => `${k}x${counts[k]}`)
      .join(" "),
    lower,
    upper,
  };
}

describe("accrue, measured on Sepolia", () => {
  it("costs what §10.2 computed, or does not", async function () {
    this.timeout(2_400_000);

    await fhevm.initializeCLIApi();
    const [signer] = await ethers.getSigners();
    const me = await signer.getAddress();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const addr = await pool.getAddress();
    console.log(`\n    pool  ${addr}`);

    await (await token.mint(me, 10_000_000n)).wait();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await token.setOperator(addr, now + 365 * 24 * 3600)).wait();
    await setFlatPrize(pool, 5_000n);

    let e = await fhevm.createEncryptedInput(addr, me).add64(100_000n).encrypt();
    await (await pool.fundReserve(e.handles[0]!, e.inputProof)).wait();

    e = await fhevm.createEncryptedInput(addr, me).add64(1_000n).encrypt();
    await (await pool.deposit(e.handles[0]!, e.inputProof)).wait();

    const results: Record<string, unknown> = { pool: addr };

    // ---- draw 1: cold cache ------------------------------------------------
    await (await pool.openDraw()).wait();
    await (await pool.forceReveal(1, 7n, 1n)).wait();

    const r1 = await (await pool.accrue(me, 1)).wait();
    const a1 = analyse(r1!.logs as never);
    console.log(`\n    accrue draw 1  (cold cache)`);
    console.log(`      gas          ${r1!.gasUsed}`);
    console.log(`      ops          ${a1.ops}`);
    console.log(`      HCU 64-bit   ${a1.lower.toLocaleString()}  (lower bound)`);
    console.log(`      HCU 128-bit  ${a1.upper.toLocaleString()}  (upper bound)`);
    results["draw1"] = { gas: r1!.gasUsed.toString(), ...a1 };

    // ---- draw 2: draw 1's snapshot is now cached ---------------------------
    e = await fhevm.createEncryptedInput(addr, me).add64(10n).encrypt();
    await (await pool.deposit(e.handles[0]!, e.inputProof)).wait();
    await (await pool.openDraw()).wait();
    await (await pool.forceReveal(2, 11n, 1n)).wait();

    const r2 = await (await pool.accrue(me, 2)).wait();
    const a2 = analyse(r2!.logs as never);
    console.log(`\n    accrue draw 2  (draw 1 snapshot cached)`);
    console.log(`      gas          ${r2!.gasUsed}`);
    console.log(`      ops          ${a2.ops}`);
    console.log(`      HCU 64-bit   ${a2.lower.toLocaleString()}  (lower bound)`);
    console.log(`      HCU 128-bit  ${a2.upper.toLocaleString()}  (upper bound)`);
    results["draw2"] = { gas: r2!.gasUsed.toString(), ...a2 };

    console.log();
    console.log(`    computed in §10.2   cold 2,374,128   cached 1,419,096`);
    console.log(`    users per tx at 20,000,000 ceiling:`);
    console.log(`      cold   ${Math.floor(20_000_000 / a1.upper)}`);
    console.log(`      cached ${Math.floor(20_000_000 / a2.upper)}`);

    const out = path.join(__dirname, "..", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "accrue-cost.json"), JSON.stringify(results, null, 2));
  });
});
