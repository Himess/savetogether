import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * The two findings that were shipped once, and must not be again.
 *
 * The first deployment had no access control of any kind. `setYieldSource` was
 * open to anyone AND grants the address it is handed operator authority over the
 * pool's own balance, which made it a one-transaction drain. `setPrize` was open
 * too, and zero bricks accrual. Neither had a test — both appeared only as setup,
 * which is exactly how a missing guard survives a green suite.
 *
 * `openDraw` had no minimum interval, and `prize` is a fixed amount that nothing
 * scales by window length, so draws could be opened back to back and the reserve
 * drained at one prize per KMS round trip. Measured before the fix in
 * `spikes/v1-draw-grinding.ts`: a two-second window paid what a full day paid.
 *
 * These tests exist to fail if any of that comes back.
 */
const DAY = 24 * 60 * 60;
const MIN_PERIOD = 3600; // one hour, the floor this pool ships with

describe("access control and the draw floor", () => {
  let pool: any;
  let token: any;
  let poolAddr: string;
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [owner, stranger] = (await ethers.getSigners()) as HardhatEthersSigner[];

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = await Token.deploy("Ghost USDC", "gUSDC", "");
    await token.waitForDeployment();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    pool = await Pool.deploy(await token.getAddress(), MIN_PERIOD);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    await (await token.mint(owner.address, 1_000_000n)).wait();
    await (await token.connect(owner).setOperator(poolAddr, until)).wait();
  });

  it("names the deployer as owner, and has no way to change it", () => {
    expect(pool.transferOwnership).to.equal(undefined);
  });

  it("refuses setYieldSource from a stranger — the drain path", async () => {
    await expect(
      pool.connect(stranger).setYieldSource(stranger.address),
    ).to.be.revertedWithCustomError(pool, "NotTheOwner");
  });

  it("refuses setPrize from a stranger", async () => {
    await expect(pool.connect(stranger).setPrize(1n)).to.be.revertedWithCustomError(
      pool,
      "NotTheOwner",
    );
  });

  it("lets the owner do both", async () => {
    await (await pool.connect(owner).setPrize(25n)).wait();
    expect(await pool.prize()).to.equal(25n);
  });

  it("does not hand a stranger operator authority over the pool's balance", async () => {
    // The specific consequence, asserted rather than implied: a failed
    // setYieldSource must leave no operator grant behind.
    await expect(pool.connect(stranger).setYieldSource(stranger.address)).to.be.reverted;
    expect(await token.isOperator(poolAddr, stranger.address)).to.equal(false);
  });

  it("refuses a second draw inside the minimum period, and names when it opens", async () => {
    const e = await fhevm.createEncryptedInput(poolAddr, owner.address).add64(1_000n).encrypt();
    await (await pool.connect(owner).deposit(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [MIN_PERIOD + 60]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();
    await (await pool.forceReveal(1, 1n, 1_000n * BigInt(MIN_PERIOD))).wait();

    // Immediately after a reveal: the previous behaviour, and the finding.
    await expect(pool.openDraw()).to.be.revertedWithCustomError(pool, "TooSoon");
  });

  it("allows the next draw once the period has passed", async () => {
    const e = await fhevm.createEncryptedInput(poolAddr, owner.address).add64(1_000n).encrypt();
    await (await pool.connect(owner).deposit(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [MIN_PERIOD + 60]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();
    await (await pool.forceReveal(1, 1n, 1_000n * BigInt(MIN_PERIOD))).wait();

    await ethers.provider.send("evm_increaseTime", [MIN_PERIOD + 1]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();
    expect(await pool.drawCount()).to.equal(2);
  });

  it("counts the floor from the previous OPEN, not from the reveal", async () => {
    // Worth pinning: `periodStart` is the previous draw's snapshot, so windows
    // tile without gaps. Measuring the floor from the reveal instead would let a
    // slow keeper shorten every window after it.
    const e = await fhevm.createEncryptedInput(poolAddr, owner.address).add64(1_000n).encrypt();
    await (await pool.connect(owner).deposit(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [MIN_PERIOD + 60]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();
    const first = await pool.drawAt(1);

    // Reveal late — most of the next period has already elapsed since the open.
    await ethers.provider.send("evm_increaseTime", [MIN_PERIOD - 10]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.forceReveal(1, 1n, 1_000n * BigInt(MIN_PERIOD))).wait();

    // Ten seconds short of the floor measured from the OPEN.
    await expect(pool.openDraw()).to.be.revertedWithCustomError(pool, "TooSoon");

    await ethers.provider.send("evm_increaseTime", [20]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();

    const second = await pool.drawAt(2);
    expect(Number(second.periodStart)).to.equal(Number(first.snapshotAt));
  });
});
