import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { FLAT_K, flatPrizes, setFlatPrize } from "./tiers";

/**
 * Phase B — the six fixes, each tested against the defect that motivated it.
 *
 * Every one of these was a real behaviour of a deployed contract, not a
 * hypothetical, and several were found by a test before they were found by a
 * user. The tests are written so that reverting the fix fails them.
 */
const DAY = 24 * 60 * 60;
const PRIZE = 1_000n;

async function base() {
  await fhevm.initializeCLIApi();
  const [owner, alice, bob, stranger] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("ERC7984Mock");
  const token = await Token.deploy("cUSDC", "cUSDC", "");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const Pool = await ethers.getContractFactory("PrizePoolHarness");
  const pool = await Pool.deploy(tokenAddr, 0);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  for (const w of [owner, alice, bob, stranger]) {
    await (await token.mint!(w!.address, 5_000_000n)).wait();
    await (await token.connect(w!).setOperator!(poolAddr, until)).wait();
  }
  return { owner, alice, bob, stranger, token, tokenAddr, pool, poolAddr };
}

async function dec(handle: string, contract: string, who: any, t = FhevmType.euint64): Promise<bigint> {
  if (handle === ethers.ZeroHash) return 0n;
  return (await fhevm.userDecryptEuint(t, handle, contract, who)) as bigint;
}

// ---------------------------------------------------------------------------

describe("B4 — the keeper is paid, and never out of a prize", () => {
  it("pays the caller a fee from the reserve", async () => {
    const { owner, alice, token, tokenAddr, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    await (await pool.setKeeperFee!(50n)).wait();

    const seed = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(100_000n).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 7n, 1n)).wait();

    const before = await dec(await token.confidentialBalanceOf!(owner!.address), tokenAddr, owner);
    await (await pool.accrueMany!([alice!.address], 1)).wait();
    const after = await dec(await token.confidentialBalanceOf!(owner!.address), tokenAddr, owner);

    expect(after - before).to.equal(50n, "the caller is paid the fee");
  });

  it("takes the fee AFTER the prize, so a winner is never displaced by it", async () => {
    const { owner, alice, token, tokenAddr, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    // A fee bigger than what is left once the prize is paid.
    await (await pool.setKeeperFee!(900n)).wait();

    // Exactly one prize in the reserve and nothing more.
    const seed = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(PRIZE).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 7n, 1n)).wait();

    const feeBefore = await dec(await token.confidentialBalanceOf!(owner!.address), tokenAddr, owner);
    await (await pool.accrueMany!([alice!.address], 1)).wait();
    const feeAfter = await dec(await token.confidentialBalanceOf!(owner!.address), tokenAddr, owner);

    const won = await dec(await pool.winningsOf!(alice!.address), poolAddr, alice);
    expect(won).to.equal(PRIZE, "the winner is paid in full");
    expect(feeAfter - feeBefore).to.equal(0n, "and the fee is declined, not the prize");
  });
});

describe("B5 — a dead keeper no longer bricks the pool", () => {
  it("refuses to cancel a draw that is not yet stale", async () => {
    const { alice, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await (await pool.openDraw!()).wait();

    await expect(pool.cancelDraw!(1)).to.be.revertedWithCustomError(pool, "NotStale");
  });

  it("lets anyone cancel after the timeout, and opens again", async () => {
    const { stranger, alice, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await (await pool.openDraw!()).wait();

    // Before the fix this was terminal: openDraw refuses while draw 1 is Open.
    await expect(pool.openDraw!()).to.be.revertedWithCustomError(pool, "PreviousDrawUnresolved");

    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(stranger!).cancelDraw!(1)).wait();

    await (await pool.openDraw!()).wait();
    expect(await pool.drawCount!()).to.equal(2n);
  });

  it("hands the cancelled window to the next draw rather than discarding it", async () => {
    const { alice, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await (await pool.openDraw!()).wait();
    const d1 = await pool.drawAt!(1);

    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.cancelDraw!(1)).wait();
    await (await pool.openDraw!()).wait();

    const d2 = await pool.drawAt!(2);
    expect(d2.periodStart).to.equal(
      d1.periodStart,
      "nobody loses the weight they earned while a keeper was dying",
    );
  });

  it("refuses to accrue against a cancelled draw", async () => {
    const { alice, pool, poolAddr } = await base();
    await setFlatPrize(pool, PRIZE);
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await (await pool.openDraw!()).wait();
    await ethers.provider.send("evm_increaseTime", [DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.cancelDraw!(1)).wait();

    await expect(pool.accrue!(alice!.address, 1)).to.be.revertedWithCustomError(pool, "DrawNotRevealed");
  });
});

describe("B6 — owner powers are bounded, and can be given up", () => {
  it("refuses a tier shape that is not strictly decreasing", async () => {
    const { pool } = await base();
    await expect(pool.setTiers!([100n, 100n, 1n], FLAT_K)).to.be.revertedWithCustomError(pool, "BadTierShape");
    await expect(pool.setTiers!(flatPrizes(1n), [100n, 10n, 2n])).to.be.revertedWithCustomError(pool, "BadTierShape");
    await expect(pool.setTiers!(flatPrizes(1n), [10n, 100n, 1n])).to.be.revertedWithCustomError(pool, "BadTierShape");
  });

  it("refuses a prize that moves further than the bound", async () => {
    const { pool } = await base();
    await (await pool.setTiers!([100n, 50n, 25n], [100n, 10n, 1n])).wait();
    await ethers.provider.send("evm_increaseTime", [7 * 3600]);
    await ethers.provider.send("evm_mine", []);
    // 25 -> 100 is 4x, and the bound is 2x.
    await expect(pool.setTiers!([400n, 200n, 100n], [100n, 10n, 1n])).to.be.revertedWithCustomError(
      pool,
      "PrizeMovedTooFar",
    );
    await (await pool.setTiers!([200n, 100n, 50n], [100n, 10n, 1n])).wait();
    expect(await pool.tierPrize!(2)).to.equal(50n);
  });

  it("refuses to change tiers again too soon", async () => {
    const { pool } = await base();
    await (await pool.setTiers!([100n, 50n, 25n], [100n, 10n, 1n])).wait();
    await expect(pool.setTiers!([120n, 60n, 30n], [100n, 10n, 1n])).to.be.revertedWithCustomError(
      pool,
      "TooSoonToChangeTiers",
    );
  });

  it("renounces, and then nothing can be reconfigured ever again", async () => {
    const { pool } = await base();
    await (await pool.setTiers!([100n, 50n, 25n], [100n, 10n, 1n])).wait();
    await (await pool.renounceOwnership!()).wait();
    expect(await pool.owner!()).to.equal(ethers.ZeroAddress);

    await ethers.provider.send("evm_increaseTime", [7 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await expect(pool.setTiers!([120n, 60n, 30n], [100n, 10n, 1n])).to.be.revertedWithCustomError(pool, "NotTheOwner");
    await expect(pool.setKeeperFee!(1n)).to.be.revertedWithCustomError(pool, "NotTheOwner");
    await expect(pool.renounceOwnership!()).to.be.revertedWithCustomError(pool, "NotTheOwner");
  });
});

describe("tiers pay the tier that was won", () => {
  it("credits the grand prize when the rarest threshold is cleared", async () => {
    const { owner, alice, pool, poolAddr } = await base();
    // Every threshold is 0 when totalWeight is 1, so the best tier always wins.
    await (await pool.setTiers!([25_000n, 5_000n, 1_000n], [100n, 10n, 1n])).wait();
    const seed = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(100_000n).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();

    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 7n, 1n)).wait();

    await (await pool.accrue!(alice!.address, 1)).wait();
    expect(await dec(await pool.winningsOf!(alice!.address), poolAddr, alice)).to.equal(
      25_000n,
      "the best tier cleared is the one paid, never several",
    );
  });

  it("gives an address with no history nothing, whatever its thresholds are", async () => {
    const { owner, alice, stranger, pool, poolAddr } = await base();
    await (await pool.setTiers!([25_000n, 5_000n, 1_000n], [100n, 10n, 1n])).wait();
    const seed = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(100_000n).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 7n, 1n)).wait();

    await (await pool.accrue!(stranger!.address, 1)).wait();
    expect(await dec(await pool.winningsOf!(stranger!.address), poolAddr, stranger)).to.equal(0n);
  });
});
