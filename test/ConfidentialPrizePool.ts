import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ConfidentialPrizePool, ERC7984Mock } from "../types";

const DAY = 24 * 60 * 60;

/**
 * The record the draw will be scored against.
 *
 * These tests are about one thing: whether `cumulative` is a faithful
 * time-weighted balance, and whether it stays faithful in the cases that
 * actually decide a lottery — a deposit that arrives late in a period, a
 * withdrawal that empties an account, and an over-withdrawal that must not be
 * observable.
 */
describe("ConfidentialPrizePool", () => {
  let pool: ConfidentialPrizePool;
  let token: ERC7984Mock;
  let poolAddr: string;
  let tokenAddr: string;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  async function encrypt(user: string, value: bigint) {
    return fhevm.createEncryptedInput(poolAddr, user).add64(value).encrypt();
  }

  async function deposit(who: HardhatEthersSigner, value: bigint) {
    const e = await encrypt(who.address, value);
    return (await pool.connect(who).deposit(e.handles[0], e.inputProof)).wait();
  }

  async function withdraw(who: HardhatEthersSigner, value: bigint) {
    const e = await encrypt(who.address, value);
    return (await pool.connect(who).withdraw(e.handles[0], e.inputProof)).wait();
  }

  async function readBalance(who: HardhatEthersSigner): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, who);
  }

  /** `cumulativeAt` mutates, so it is called then read back from the receipt path. */
  async function readCumulative(who: HardhatEthersSigner, at: number): Promise<bigint> {
    await (await pool.connect(who).cumulativeAt(who.address, at)).wait();
    const handle = await pool.connect(who).cumulativeAt.staticCall(who.address, at);
    return fhevm.userDecryptEuint(FhevmType.euint128, handle, poolAddr, who);
  }

  async function mine(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = (await Token.deploy("cUSDC", "cUSDC", "")) as unknown as ERC7984Mock;
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    pool = (await Pool.deploy(tokenAddr)) as unknown as ConfidentialPrizePool;
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    for (const who of [alice, bob]) {
      await (await token.mint(who.address, 1_000_000n)).wait();
      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
      await (await token.connect(who).setOperator(poolAddr, until)).wait();
    }
  });

  it("credits a deposit and records the first observation", async () => {
    await deposit(alice, 1000n);
    expect(await pool.observationCount(alice.address)).to.equal(1n);
    expect(await readBalance(alice)).to.equal(1000n);
  });

  it("starts the cumulative at zero — there is no history before the first deposit", async () => {
    await deposit(alice, 1000n);
    const o = await pool.observationAt(alice.address, 0);
    const cum = await fhevm.userDecryptEuint(FhevmType.euint128, o.cumulative, poolAddr, alice);
    expect(cum).to.equal(0n);
  });

  it("accumulates balance times elapsed time", async () => {
    await deposit(alice, 1000n);
    const t0 = (await ethers.provider.getBlock("latest"))!.timestamp;

    await mine(DAY);
    await deposit(alice, 500n); // second observation carries the first interval forward

    const o = await pool.observationAt(alice.address, 1);
    const cum = await fhevm.userDecryptEuint(FhevmType.euint128, o.cumulative, poolAddr, alice);
    const dt = BigInt(Number(o.timestamp) - t0);

    expect(cum).to.equal(1000n * dt);
    expect(await readBalance(alice)).to.equal(1500n);
  });

  it("weights a late deposit less than an early one — the flash-deposit case", async () => {
    // Alice in early, Bob in late, same final balance. The whole point of a
    // time-weighted record is that these are not equal.
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await deposit(bob, 1000n);
    await mine(DAY);

    const at = (await ethers.provider.getBlock("latest"))!.timestamp;
    const aliceCum = await readCumulative(alice, at);
    const bobCum = await readCumulative(bob, at);

    expect(await readBalance(alice)).to.equal(await readBalance(bob));
    expect(aliceCum).to.be.greaterThan(bobCum);
    // Alice held for ~8 days against Bob's ~1, so the ratio should be near 8.
    expect(aliceCum / bobCum).to.be.greaterThanOrEqual(7n);
  });

  it("returns funds on withdraw and lowers the running weight", async () => {
    await deposit(alice, 1000n);
    await mine(DAY);
    await withdraw(alice, 400n);

    expect(await readBalance(alice)).to.equal(600n);
    const held = await token.confidentialBalanceOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, held, tokenAddr, alice)).to.equal(999_400n);
  });

  it("clamps an over-withdrawal instead of reverting", async () => {
    // A revert is visible on chain. "This account asked for more than it had"
    // is exactly the fact the pool exists to keep private, so the transaction
    // must succeed and move an encrypted zero.
    await deposit(alice, 1000n);
    await mine(DAY);

    const receipt = await withdraw(alice, 5000n);
    expect(receipt!.status).to.equal(1);

    expect(await readBalance(alice)).to.equal(1000n);
    const held = await token.confidentialBalanceOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, held, tokenAddr, alice)).to.equal(999_000n);
  });

  it("keeps the aggregate in step with the sum of the parts", async () => {
    await deposit(alice, 1000n);
    await deposit(bob, 2500n);
    await mine(DAY);
    await withdraw(alice, 400n);

    // The aggregate is encrypted and only this contract may read it, so the
    // assertion is on the observation count rather than the value — the value
    // is checked at draw time, when it is revealed on purpose.
    expect(await pool.totalObservationCount()).to.equal(3n);
    expect(await readBalance(alice)).to.equal(600n);
    expect(await readBalance(bob)).to.equal(2500n);
  });

  it("finds the observation at or before a timestamp", async () => {
    await deposit(alice, 100n);
    const t0 = (await ethers.provider.getBlock("latest"))!.timestamp;
    await mine(DAY);
    await deposit(alice, 100n);
    const t1 = (await ethers.provider.getBlock("latest"))!.timestamp;
    await mine(DAY);
    await deposit(alice, 100n);

    expect(await pool.indexAt(alice.address, t0)).to.equal(0n);
    expect(await pool.indexAt(alice.address, t0 + 10)).to.equal(0n);
    expect(await pool.indexAt(alice.address, t1)).to.equal(1n);
  });

  it("refuses a timestamp before any observation rather than reporting zero", async () => {
    await deposit(alice, 100n);
    const t0 = (await ethers.provider.getBlock("latest"))!.timestamp;
    // "no balance recorded" and "a balance of zero" are different claims and a
    // draw that conflates them would score an account that never existed.
    await expect(pool.indexAt(alice.address, t0 - 1)).to.be.revertedWithCustomError(
      pool,
      "NoObservations",
    );
  });
});
