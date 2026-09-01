/**
 * What an observation costs to store.
 *
 * The last unmeasured unknown from findings.md §6.6, and it has to be answered
 * before the storage layout is fixed, because changing it afterwards is a
 * migration.
 *
 * An observation is `uint40 timestamp` + `euint64 balance` + `euint128
 * cumulative`. The two ciphertexts are `bytes32` handles, so neither can share a
 * slot with anything — the question is whether the timestamp is riding in a slot
 * of its own at a cold write each time, and whether pre-initialising a ring
 * buffer to turn cold writes into warm ones pays for itself.
 *
 * Storage gas is pure EVM and identical to Sepolia. The FHE operations inside
 * these transactions are mocked here and their gas is NOT comparable, which is
 * why the figure that matters is the DIFFERENCE between consecutive deposits
 * rather than any absolute total.
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const COLD_SSTORE = 20_000n;
const WARM_SSTORE = 2_900n;

describe("observation storage cost", () => {
  it("measures what an observation costs to write", async function () {
    this.timeout(300_000);

    await fhevm.initializeCLIApi();
    const [, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    await (await token.mint(alice.address, 10_000_000n)).wait();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await token.connect(alice).setOperator(poolAddr, now + 365 * 24 * 3600)).wait();

    const rows: { i: number; gas: string; delta: string }[] = [];
    let prev: bigint | null = null;

    console.log("\n    deposit  gasUsed     delta");
    for (let i = 0; i < 12; i++) {
      await ethers.provider.send("evm_increaseTime", [3600]);
      const enc = await fhevm.createEncryptedInput(poolAddr, alice.address).add64(100n).encrypt();
      const receipt = await (
        await pool.connect(alice).deposit(enc.handles[0]!, enc.inputProof)
      ).wait();
      const gas = receipt!.gasUsed;
      const delta = prev === null ? 0n : gas - prev;
      console.log(
        `      ${String(i).padStart(2)}     ${String(gas).padStart(9)}   ${prev === null ? "—" : String(delta).padStart(8)}`,
      );
      rows.push({ i, gas: gas.toString(), delta: delta.toString() });
      prev = gas;
    }

    const steady = rows.slice(2).map((r) => BigInt(r.gas));
    const mean = steady.reduce((a, b) => a + b, 0n) / BigInt(steady.length);
    const spread = steady.map((g) => Number(g - mean));

    console.log();
    console.log(`    first deposit        ${rows[0]!.gas}`);
    console.log(`    second deposit       ${rows[1]!.gas}`);
    console.log(`    steady-state mean    ${mean}`);
    console.log(`    steady-state spread  ${Math.min(...spread)} .. ${Math.max(...spread)}`);

    console.log();
    console.log("    layout accounting");
    console.log("      slots per observation        3  (timestamp, balance handle, cumulative handle)");
    console.log(`      cold writes per observation  ${3n * COLD_SSTORE} gas`);
    console.log(
      `      timestamps packed 6/slot would save about ${(COLD_SSTORE * 5n) / 6n} gas per observation`,
    );

    console.log();
    console.log("    ring-buffer pre-initialisation, against a growable array");
    for (const card of [8, 16, 32, 64]) {
      const upfront = BigInt(card) * 3n * COLD_SSTORE;
      const savingPerObservation = (COLD_SSTORE - WARM_SSTORE) * 3n;
      console.log(
        `      cardinality ${String(card).padStart(3)}   upfront ${String(upfront).padStart(9)} gas   pays back after ${upfront / savingPerObservation} observations`,
      );
    }

    const out = path.join(__dirname, "..", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "storage-cost.json"),
      JSON.stringify({ rows, mean: mean.toString() }, null, 2),
    );
  });
});
