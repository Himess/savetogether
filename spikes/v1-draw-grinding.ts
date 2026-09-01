import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * V1 — can `openDraw()` be ground?
 *
 * `openDraw` (ConfidentialPrizePool.sol:367) enforces exactly two things: the
 * previous draw must be Revealed, and the pool must not be empty. There is no
 * minimum interval. So the question is economic rather than structural: does
 * opening draws in a tight loop extract more than the windows earned?
 *
 * The suspicion is that it does, because `prize` (:98) is a FIXED plaintext
 * amount and nothing in `accrue` scales it by how long the window was. If that
 * holds, the number of draws is the only thing gating payout and the number of
 * draws is unbounded — which is the same class of finding as `setYieldSource`.
 *
 * Two cases are worth separating, because they behave differently:
 *
 *   A  consecutive draws with a real gap. Everyone has non-zero weight and the
 *      attacker wins with probability w/total EVERY TIME, for a fixed prize.
 *   B  a lone depositor, which is not an attack at all — it is what a judge
 *      trying the live app produces, and w/total is 1.
 *
 *   npx hardhat test spikes/v1-draw-grinding.ts
 */
const DAY = 24 * 60 * 60;
const PRIZE = 25n;
const RESERVE = 10_000n;

describe("V1 — draw grinding", () => {
  it("lets a lone depositor take the prize once per draw, as fast as draws can be opened", async () => {
    await fhevm.initializeCLIApi();
    const [funder, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("Ghost USDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice]) {
      await (await token.mint!(who!.address, 1_000_000n)).wait();
      await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
    }

    await (await pool.setPrize!(PRIZE)).wait();
    const seed = await fhevm.createEncryptedInput(poolAddr, funder!.address).add64(RESERVE).encrypt();
    await (await pool.connect(funder!).fundReserve!(seed.handles[0], seed.inputProof)).wait();

    // One depositor. This is the judge-alone case, not a contrived one.
    const dep = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(1_000n).encrypt();
    await (await pool.connect(alice!).deposit!(dep.handles[0], dep.inputProof)).wait();

    const winnings = async (): Promise<bigint> => {
      const h = await pool.winningsOf!(alice!.address);
      if (h === ethers.ZeroHash) return 0n;
      return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!);
    };

    // Ten draws, each separated by a single minute — far tighter than any
    // schedule the product describes, and nothing in the contract objects.
    const ROUNDS = 10;
    const GAP = 60;
    for (let i = 0; i < ROUNDS; i++) {
      await ethers.provider.send("evm_increaseTime", [GAP]);
      await ethers.provider.send("evm_mine", []);
      const id = Number(await pool.drawCount!()) + 1;
      await (await pool.openDraw!()).wait();

      // The harness stands in for the KMS. `totalWeight` is alice's weight
      // because she is the only depositor; any R below it makes her the winner,
      // and thresholdFor returns a value in [0, totalWeight-1] regardless.
      await (await pool.forceReveal!(id, 1n, BigInt(1_000 * GAP))).wait();
      await (await pool.accrue!(alice!.address, id)).wait();
    }

    const won = await winnings();
    console.log(`      ${ROUNDS} draws in ${(ROUNDS * GAP) / 60} simulated minutes`);
    console.log(`      alice won ${won} with a prize of ${PRIZE} per draw`);
    console.log(`      reserve seeded at ${RESERVE}`);

    // The claim under test: payout scales with the NUMBER of draws, not with
    // the time the money was actually at work.
    expect(won).to.equal(PRIZE * BigInt(ROUNDS));
  });

  it("still pays a lone depositor when the window is one second long", async () => {
    await fhevm.initializeCLIApi();
    const [funder, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("Ghost USDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice]) {
      await (await token.mint!(who!.address, 1_000_000n)).wait();
      await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
    }
    await (await pool.setPrize!(PRIZE)).wait();
    const seed = await fhevm.createEncryptedInput(poolAddr, funder!.address).add64(RESERVE).encrypt();
    await (await pool.connect(funder!).fundReserve!(seed.handles[0], seed.inputProof)).wait();
    const dep = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(1_000n).encrypt();
    await (await pool.connect(alice!).deposit!(dep.handles[0], dep.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 1n, BigInt(1_000 * DAY))).wait();
    await (await pool.accrue!(alice!.address, 1)).wait();

    const afterFirst = await (async () => {
      const h = await pool.winningsOf!(alice!.address);
      return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!);
    })();

    // Second draw opened immediately. The window is whatever the chain advanced
    // between the two opens — a second or two — and the real `totalWeight` is
    // alice's own weight over it, because she is the only depositor. That is
    // what a genuine KMS reveal would publish, so it is what is passed here.
    const beforeOpen = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await pool.openDraw!()).wait();
    const d2 = await pool.drawAt!(2);
    const window = Number(d2.snapshotAt) - beforeOpen + 1;
    await (await pool.forceReveal!(2, 1n, BigInt(1_000 * Math.max(window, 1)))).wait();
    await (await pool.accrue!(alice!.address, 2)).wait();

    const afterSecond = await (async () => {
      const h = await pool.winningsOf!(alice!.address);
      return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!);
    })();

    console.log(`      window between the two draws: ~${window}s`);
    console.log(`      after a full day: ${afterFirst}`);
    console.log(`      after a ${window}-second window: ${afterSecond}`);

    // The point: a one-second window pays exactly what a one-day window pays,
    // because `prize` is a fixed plaintext amount that nothing scales by time.
    expect(afterSecond).to.equal(afterFirst + PRIZE);
  });
});
