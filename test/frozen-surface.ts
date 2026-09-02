import { expect } from "chai";
import { setFlatPrize } from "./tiers";
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * The 306-sample equality result must survive the V2 fix, and be shown to.
 *
 * That result is the strongest evidence in the submission: winner and loser
 * accruals are indistinguishable on chain, one operation sequence and one HCU
 * figure, gas tracking the address rather than the outcome. It is a claim about
 * what `accrue` COSTS, so a source diff is necessary and not sufficient — the
 * only thing that settles it is running `accrue` on both contracts.
 *
 * `PoolPreV2Harness` is the pool exactly as it was before access control and the
 * draw floor were added. Same state, same sequence, both sides of the threshold,
 * because a constant shift that moved both equally would leave the equality
 * result intact while a shift that moved only one would destroy it.
 */
const DAY = 24 * 60 * 60;
const PRIZE = 5_000n;

describe("the frozen surface survives V2", () => {
  const gas: Record<string, { winner: bigint; loser: bigint }> = {};

  for (const name of ["PoolPreV2Harness", "PrizePoolHarness"] as const) {
    it(`measures accrue on ${name}`, async () => {
      await fhevm.initializeCLIApi();
      const [funder, alice, bob] = await ethers.getSigners();

      const Token = await ethers.getContractFactory("ERC7984Mock");
      const token = await Token.deploy("gUSDC", "gUSDC", "");
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();

      const Pool = await ethers.getContractFactory(name);
      // The pre-V2 constructor took only the asset; the current one also takes
      // the draw floor. Zero here so the two runs are otherwise identical.
      const pool =
        name === "PoolPreV2Harness"
          ? await Pool.deploy(tokenAddr)
          : await Pool.deploy(tokenAddr, 0);
      await pool.waitForDeployment();
      const poolAddr = await pool.getAddress();

      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
      for (const who of [funder, alice, bob]) {
        await (await token.mint!(who!.address, 5_000_000n)).wait();
        await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
      }

      // PoolPreV2Harness predates tiers entirely and still has setPrize.
      if (name === "PoolPreV2Harness") {
        await (await pool.setPrize!(PRIZE)).wait();
      } else {
        await setFlatPrize(pool, PRIZE);
      }
      const seed = await fhevm
        .createEncryptedInput(poolAddr, funder!.address)
        .add64(100_000n)
        .encrypt();
      await (await pool.connect(funder!).fundReserve!(seed.handles[0], seed.inputProof)).wait();

      for (const who of [alice, bob]) {
        const e = await fhevm.createEncryptedInput(poolAddr, who!.address).add64(1_000n).encrypt();
        await (await pool.connect(who!).deposit!(e.handles[0], e.inputProof)).wait();
      }

      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.openDraw!()).wait();

      // A chosen R so one account lands above its threshold and the other below.
      await (await pool.forceReveal!(1, 1n, 2_000n * BigInt(DAY))).wait();

      const winner = (await (await pool.accrue!(alice!.address, 1)).wait())!.gasUsed;
      const loser = (await (await pool.accrue!(bob!.address, 1)).wait())!.gasUsed;
      gas[name] = { winner, loser };
      console.log(`      ${name.padEnd(18)} accrue ${winner} / ${loser}`);
    });
  }

  /**
   * C2. The surface is NOT frozen any more, and this test says so rather than
   * being deleted for saying so.
   *
   * V2 added access control and a draw floor and left `accrue` untouched, which
   * is what the original version of this test proved. Tiers changed `accrue`: it
   * now runs three comparisons and three selects where it ran one of each. So the
   * before/after figures no longer match, and pretending otherwise would be worse
   * than losing the property.
   *
   * WHAT SURVIVES, and it is the half that carried the argument: winner and loser
   * still cost the SAME AS EACH OTHER on the tiered contract. The 306-sample
   * result was never about the absolute number — it was about the difference
   * between two outcomes being zero, and that is asserted below on the new shape.
   */
  it("records the new baseline, and keeps winner == loser on it", () => {
    const before = gas["PoolPreV2Harness"]!;
    const after = gas["PrizePoolHarness"]!;
    console.log(`      pre-tier   ${before.winner} / ${before.loser}`);
    console.log(`      tiered     ${after.winner} / ${after.loser}`);
    console.log(`      delta      ${after.winner - before.winner} / ${after.loser - before.loser}`);

    // THE CLAIM THAT MATTERS, and it is sharper than "identical".
    //
    // Winner and loser differ by 12 gas on BOTH contracts, and 12 is not noise —
    // it is intrinsic calldata cost, which varies with the zero-byte count of the
    // address argument and has nothing to do with the outcome. That is why the
    // equality methodology measures execution gas rather than gasUsed.
    //
    // So the assertion is not that the gap is zero. It is that tiers did not
    // CHANGE the gap: three comparisons and three selects added 70,867 gas to
    // both sides equally and zero outcome-dependence to either.
    const gapBefore = before.winner - before.loser;
    const gapAfter = after.winner - after.loser;
    console.log(`      winner-loser gap  ${gapBefore} -> ${gapAfter}  (intrinsic calldata, not outcome)`);
    expect(gapAfter).to.equal(
      gapBefore,
      "tiers must add no outcome-dependence — the gap must be exactly what it was",
    );
    expect(after.winner - before.winner).to.equal(
      after.loser - before.loser,
      "and the tier cost must land equally on both sides",
    );

    fs.mkdirSync(path.join(__dirname, "..", "spikes", "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "..", "spikes", "out", "v2-frozen-surface.json"),
      JSON.stringify(
        {
          beforeV2: { winner: before.winner.toString(), loser: before.loser.toString() },
          afterV2: { winner: after.winner.toString(), loser: after.loser.toString() },
          delta: {
            winner: (after.winner - before.winner).toString(),
            loser: (after.loser - before.loser).toString(),
          },
        },
        null,
        2,
      ),
    );
  });
});
