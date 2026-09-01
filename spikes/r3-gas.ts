import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * R3, the part that actually matters — does adding a fractional deposit change
 * what `accrue` costs?
 *
 * The source check says the frozen functions are untouched and the bytecode
 * check says the contract grew by 777 bytes and everything after the dispatcher
 * moved. Neither settles the question. The 306-sample equality result is a claim
 * about EXECUTION COST being indistinguishable between a winning accrual and a
 * losing one, so the test is to run both, on two pools that differ only by the
 * added function, and compare.
 *
 * Two accruals per pool, one on each side of the threshold, because a constant
 * shift that moved both equally would leave the equality result intact while a
 * shift that moved only one would destroy it.
 *
 *   npx hardhat test spikes/r3-gas.ts
 */
const DAY = 24 * 60 * 60;
const PRIZE = 5_000n;

describe("R3 — accrue is unchanged by a fractional deposit path", () => {
  const gasByPool: Record<string, { winner: bigint; loser: bigint }> = {};

  for (const poolName of ["SpikeHarnessBaseline", "SpikeHarnessVariant"]) {
    it(`measures accrue on ${poolName}`, async () => {
      await fhevm.initializeCLIApi();
      const [funder, alice, bob] = await ethers.getSigners();

      const Token = await ethers.getContractFactory("ERC7984Mock");
      const token = await Token.deploy("cUSDC", "cUSDC", "");
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();

      const Pool = await ethers.getContractFactory(poolName);
      const pool = await Pool.deploy(tokenAddr, 0);
      await pool.waitForDeployment();
      const poolAddr = await pool.getAddress();

      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
      for (const who of [funder, alice, bob]) {
        await (await token.mint!(who!.address, 5_000_000n)).wait();
        await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
      }

      await (await pool.setPrize!(PRIZE)).wait();
      const fundEnc = await fhevm
        .createEncryptedInput(poolAddr, funder!.address)
        .add64(100_000n)
        .encrypt();
      await (
        await pool.connect(funder!).fundReserve!(fundEnc.handles[0], fundEnc.inputProof)
      ).wait();

      for (const who of [alice, bob]) {
        const e = await fhevm.createEncryptedInput(poolAddr, who!.address).add64(1_000n).encrypt();
        await (await pool.connect(who!).deposit!(e.handles[0], e.inputProof)).wait();
      }

      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.openDraw!()).wait();

      // A chosen R so one account is above its threshold and the other below,
      // rather than hoping. Both accruals still have to cost the same.
      await (await pool.forceReveal!(1, 1n, 2_000n * BigInt(DAY))).wait();

      const winner = (await (await pool.accrue!(alice!.address, 1)).wait())!.gasUsed;
      const loser = (await (await pool.accrue!(bob!.address, 1)).wait())!.gasUsed;

      gasByPool[poolName] = { winner, loser };
      console.log(`      ${poolName}: accrue ${winner} and ${loser}`);
    });
  }

  it("costs the same in both contracts", () => {
    const a = gasByPool["SpikeHarnessBaseline"]!;
    const b = gasByPool["SpikeHarnessVariant"]!;
    console.log(`      baseline  ${a.winner} / ${a.loser}`);
    console.log(`      variant   ${b.winner} / ${b.loser}`);
    console.log(`      delta     ${b.winner - a.winner} / ${b.loser - a.loser}`);

    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "out", "r3-gas.json"),
      JSON.stringify(
        {
          baseline: { winner: a.winner.toString(), loser: a.loser.toString() },
          variant: { winner: b.winner.toString(), loser: b.loser.toString() },
          delta: {
            winner: (b.winner - a.winner).toString(),
            loser: (b.loser - a.loser).toString(),
          },
        },
        null,
        2,
      ),
    );

    expect(b.winner).to.equal(a.winner);
    expect(b.loser).to.equal(a.loser);
  });
});
