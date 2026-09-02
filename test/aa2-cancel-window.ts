import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { setFlatPrize } from "./tiers";

/**
 * AA2 — does a cancelled draw's window actually reach the next draw?
 *
 * B5 says it does, and `openDraw` does its half: when the previous draw was
 * Cancelled it takes `periodStart` from that draw's `periodStart` rather than its
 * `snapshotAt`, so the new draw's window covers both.
 *
 * `accrue` computes the other half, and it did NOT agree:
 *
 *     lower = _snapshotCumulative(user, drawId - 1, _draws[drawId - 1].snapshotAt)
 *
 * That is the CANCELLED draw's snapshot, not the handed-over start. So the
 * interval [periodStart(N-1), snapshotAt(N-1)] was counted in `totalWeight` —
 * which `openDraw` computes from `periodStart` — and NOT in any user's weight.
 *
 * The consequence is not a rounding error. The thresholds are drawn from
 * `[0, totalWeight)` and the user weights no longer sum to it, so every
 * participant's odds are understated by exactly the discarded window and the draw
 * produces fewer winners than the design says it should.
 *
 * Two things that are each correct alone, disagreeing at the seam — which is the
 * shape every defect in this project has had.
 */
const DAY = 24 * 60 * 60;
const HOUR = 3600;

async function setup() {
  await fhevm.initializeCLIApi();
  const [deployer, alice] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("ERC7984Mock");
  const token = await Token.deploy("cUSDC", "cUSDC", "");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const Pool = await ethers.getContractFactory("PrizePoolHarness");
  const pool = await Pool.deploy(tokenAddr, 0);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  for (const who of [deployer, alice]) {
    await (await token.mint!(who!.address, 5_000_000n)).wait();
    await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
  }
  await setFlatPrize(pool, 1_000n);

  return { deployer, alice, token, pool, poolAddr };
}

/** Alice's weight for a draw, in the clear. She is the subject, so she may read it. */
async function weight(pool: any, poolAddr: string, alice: any, drawId: number): Promise<bigint> {
  await (await pool.connect(alice).weightFor!(drawId, alice.address)).wait();
  const h: string = await pool.connect(alice).weightFor!.staticCall(drawId, alice.address);
  return (await fhevm.userDecryptEuint(FhevmType.euint128, h, poolAddr, alice)) as bigint;
}

async function mine(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("AA2 — a cancelled draw's window must reach the next draw's accrual", () => {
  it("openDraw hands the window over", async () => {
    const { alice, pool, poolAddr } = await setup();

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

    await mine(HOUR);
    await (await pool.openDraw!()).wait();
    const d1 = await pool.drawAt!(1);

    await mine(25 * HOUR);
    await (await pool.cancelDraw!(1)).wait();
    await (await pool.openDraw!()).wait();
    const d2 = await pool.drawAt!(2);

    expect(d2.periodStart).to.equal(d1.periodStart, "the next draw starts where the cancelled one did");
    expect(d2.snapshotAt).to.be.greaterThan(d1.snapshotAt);
  });

  it("and the accrued weight covers that whole window, counted once", async () => {
    const { alice, pool, poolAddr } = await setup();
    const BAL = 10_000n;

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(BAL).encrypt();
    const dep = await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    const depositedAt = BigInt((await ethers.provider.getBlock(dep!.blockNumber))!.timestamp);

    await mine(HOUR);
    await (await pool.openDraw!()).wait();

    // Nobody reveals draw 1. It goes stale and is abandoned.
    await mine(25 * HOUR);
    await (await pool.cancelDraw!(1)).wait();

    await (await pool.openDraw!()).wait();
    const d2 = await pool.drawAt!(2);
    await (await pool.forceReveal!(2, 7n, 1n)).wait();

    // The weight the design says draw 2 should carry: the balance held for the
    // WHOLE window it was handed, from the deposit to draw 2's snapshot.
    const from = BigInt(d2.periodStart) > depositedAt ? BigInt(d2.periodStart) : depositedAt;
    const expected = BAL * (BigInt(d2.snapshotAt) - from);

    const actual = await weight(pool, poolAddr, alice, 2);
    console.log(`      window ${Number(BigInt(d2.snapshotAt) - BigInt(d2.periodStart))}s   expected ${expected}   actual ${actual}`);

    expect(actual).to.equal(
      expected,
      "the handed-over window is missing from the weight, so it was counted in totalWeight and nowhere else",
    );
  });

  it("a normal, uncancelled sequence is unchanged", async () => {
    const { alice, pool, poolAddr } = await setup();
    const BAL = 10_000n;

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(BAL).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

    await mine(HOUR);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 7n, 1n)).wait();

    await mine(HOUR);
    await (await pool.openDraw!()).wait();
    const d2 = await pool.drawAt!(2);
    await (await pool.forceReveal!(2, 7n, 1n)).wait();

    // Draw 2's window opens where draw 1 closed; the weight is exactly that span.
    const expected = BAL * (BigInt(d2.snapshotAt) - BigInt(d2.periodStart));
    const actual = await weight(pool, poolAddr, alice, 2);
    expect(actual).to.equal(expected, "the ordinary path must not change");
  });
});

/**
 * The decisive test, and the first version of this file did not contain it.
 *
 * `weightFor` computes from `d.periodStart`, so it reports the handed-over window
 * correctly — which is what the test above proves, and it is not the question.
 * `accrue` computes its own lower bound from `_draws[drawId - 1].snapshotAt`,
 * which after a cancellation is a DIFFERENT timestamp. The two can disagree, and
 * what a participant is actually credited comes from `accrue`.
 *
 * Observing it needs a construction, because the weight `accrue` used is never
 * published: pick a threshold that sits strictly between the two candidate
 * weights. If `accrue` used the handed-over start the participant wins; if it
 * used the cancelled snapshot they lose. The outcome reports which timestamp was
 * used without either being revealed.
 */
describe("AA2b — which lower bound does accrue actually use?", () => {
  it("credits on the handed-over window, not the cancelled snapshot", async () => {
    const { deployer, alice, pool, poolAddr } = await setup();
    const BAL = 10_000n;
    const PRIZE = 1_000n;

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(BAL).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

    const seed = await fhevm.createEncryptedInput(poolAddr, deployer!.address).add64(100_000n).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();

    await mine(HOUR);
    await (await pool.openDraw!()).wait();
    const d1 = await pool.drawAt!(1);

    await mine(25 * HOUR);
    await (await pool.cancelDraw!(1)).wait();
    await (await pool.openDraw!()).wait();
    const d2 = await pool.drawAt!(2);

    const full = BAL * (BigInt(d2.snapshotAt) - BigInt(d2.periodStart)); // handed over
    const short = BAL * (BigInt(d2.snapshotAt) - BigInt(d1.snapshotAt)); // cancelled snapshot
    expect(full).to.be.greaterThan(short, "the two candidates must actually differ");

    // A threshold in the gap. `uniform` over [0, total) with total = full, so a
    // draw of r whose threshold lands between them separates the two behaviours.
    const uniform = (entropy: bigint, upper: bigint): bigint => {
      const MAX = (1n << 256n) - 1n;
      const min = (MAX - upper + 1n) % upper;
      let x = entropy;
      while (x < min) x = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [x])));
      return x % upper;
    };
    const th = (r: bigint, tier: number): bigint =>
      uniform(
        BigInt(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ["uint64", "uint32", "address", "uint8"],
              [r, 2, alice!.address, tier],
            ),
          ),
        ),
        full,
      );

    let chosen = 0n;
    for (let r = 1n; r < 60_000n; r++) {
      // setFlatPrize makes every tier identical, so all three must land in the gap
      // for the outcome to be unambiguous.
      if ([0, 1, 2].every((t) => th(r, t) > short && th(r, t) < full)) { chosen = r; break; }
    }
    expect(chosen).to.not.equal(0n, "no separating randomness found");

    await (await pool.forceReveal!(2, chosen, full)).wait();
    await (await pool.accrue!(alice!.address, 2)).wait();

    const h: string = await pool.winningsOf!(alice!.address);
    const won = h === ethers.ZeroHash
      ? 0n
      : ((await fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!)) as bigint);

    console.log(`      short ${short} < threshold < full ${full}   won ${won}`);
    expect(won).to.equal(
      PRIZE,
      "accrue used the cancelled draw's snapshot, so the handed-over window was counted in totalWeight and in nobody's weight",
    );
  });
});
