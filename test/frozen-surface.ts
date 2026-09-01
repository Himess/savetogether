import { expect } from "chai";
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

      await (await pool.setPrize!(PRIZE)).wait();
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

  it("costs exactly the same before and after the fix", () => {
    const before = gas["PoolPreV2Harness"]!;
    const after = gas["PrizePoolHarness"]!;
    console.log(`      before V2  ${before.winner} / ${before.loser}`);
    console.log(`      after V2   ${after.winner} / ${after.loser}`);
    console.log(`      delta      ${after.winner - before.winner} / ${after.loser - before.loser}`);

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

    expect(after.winner).to.equal(before.winner);
    expect(after.loser).to.equal(before.loser);
  });
});
