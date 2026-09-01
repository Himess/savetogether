/**
 * The real denominator.
 *
 * `test/storage-cost.ts` establishes that an observation costs three cold
 * SSTOREs — 60,000 gas — and that figure is pure EVM and transfers to any chain.
 * What does NOT transfer is the total deposit gas measured against the mock,
 * because the mock's FHE operations are not the coprocessor's.
 *
 * So the storage fraction cannot be stated from the local run alone. This
 * measures a deposit on live Sepolia, against a real coprocessor, so the
 * cardinality decision is made against a measured denominator rather than an
 * assumed one.
 *
 *   npx hardhat test test/sepolia-deposit.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

describe("deposit on live Sepolia", () => {
  it("measures deposit gas against the real coprocessor", async function () {
    this.timeout(1_800_000);

    await fhevm.initializeCLIApi();
    const [signer] = await ethers.getSigners();
    const me = await signer.getAddress();
    console.log(`\n    signer ${me}`);

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    console.log(`    token ${tokenAddr}`);
    console.log(`    pool  ${poolAddr}`);

    await (await token.mint(me, 10_000_000n)).wait();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await token.setOperator(poolAddr, now + 365 * 24 * 3600)).wait();

    const rows: { i: number; gas: string; tx: string }[] = [];
    console.log("\n    deposit  gasUsed     delta");
    let prev: bigint | null = null;
    for (let i = 0; i < 4; i++) {
      const enc = await fhevm.createEncryptedInput(poolAddr, me).add64(100n).encrypt();
      const tx = await pool.deposit(enc.handles[0]!, enc.inputProof);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed;
      console.log(
        `      ${i}      ${String(gas).padStart(9)}   ${prev === null ? "—" : String(gas - prev).padStart(8)}`,
      );
      rows.push({ i, gas: gas.toString(), tx: tx.hash });
      prev = gas;
    }

    const steady = rows.slice(1).map((r) => BigInt(r.gas));
    const mean = steady.reduce((a, b) => a + b, 0n) / BigInt(steady.length);
    const storage = 60_000n;
    console.log();
    console.log(`    steady-state deposit    ${mean} gas`);
    console.log(`    of which observation    ${storage} gas  (3 cold SSTOREs)`);
    console.log(`    storage fraction        ${(storage * 1000n) / mean / 10n}.${((storage * 1000n) / mean) % 10n}%`);

    const out = path.join(__dirname, "..", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "sepolia-deposit.json"),
      JSON.stringify({ token: tokenAddr, pool: poolAddr, rows, mean: mean.toString() }, null, 2),
    );
  });
});
