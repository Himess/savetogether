import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { PrizePoolHarness, ERC7984Mock } from "../types";

const DAY = 24 * 60 * 60;
const PRIZE = 5_000n;

/**
 * Accrual: permissionless, unconditional, idempotent.
 *
 * Nobody claims in this protocol. The threshold is a pure function of public
 * inputs, so a participant can determine their own result off chain with no
 * transaction — which means a loser has no reason to claim, only winners would,
 * and "who claimed" would become "who won". The claim is removed rather than
 * motivated.
 *
 * What has to hold for that to work:
 *
 *   - accrual runs for everyone, and the plaintext idempotence flag therefore
 *     carries no information
 *   - a losing accrual and a winning one are the same transaction shape
 *   - the cache is a cost optimisation, never a correctness condition, so a cold
 *     cache and an out-of-order draw both give the same answer
 *   - a keeper who misses someone is not a privacy failure, because the next
 *     ordinary deposit or withdrawal sweeps the credit in silently
 */
describe("accrual", () => {
  let pool: PrizePoolHarness;
  let token: ERC7984Mock;
  let poolAddr: string;
  let funder: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let latecomer: HardhatEthersSigner;

  async function deposit(who: HardhatEthersSigner, value: bigint) {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(value).encrypt();
    return (await pool.connect(who).deposit(e.handles[0], e.inputProof)).wait();
  }

  async function withdraw(who: HardhatEthersSigner, value: bigint) {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(value).encrypt();
    return (await pool.connect(who).withdraw(e.handles[0], e.inputProof)).wait();
  }

  async function readBalance(who: HardhatEthersSigner): Promise<bigint> {
    const h = await pool.confidentialBalanceOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, who);
  }

  async function readWinnings(who: HardhatEthersSigner): Promise<bigint> {
    const h = await pool.winningsOf(who.address);
    if (h === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, who);
  }

  async function mine(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  /**
   * Reveals with a chosen R, so a test can put a named account on either side of
   * its threshold instead of hoping. `totalWeight` is set to the value the draw
   * would have revealed.
   */
  async function revealWith(drawId: number, r: bigint, total: bigint) {
    await (await pool.forceReveal(drawId, r, total)).wait();
  }

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [funder, alice, bob, latecomer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = (await Token.deploy("cUSDC", "cUSDC", "")) as unknown as ERC7984Mock;
    await token.waitForDeployment();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    pool = (await Pool.deploy(await token.getAddress(), 0)) as unknown as PrizePoolHarness;
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice, bob, latecomer]) {
      await (await token.mint(who.address, 5_000_000n)).wait();
      await (await token.connect(who).setOperator(poolAddr, until)).wait();
    }

    await (await pool.setPrize(PRIZE)).wait();
    const e = await fhevm.createEncryptedInput(poolAddr, funder.address).add64(100_000n).encrypt();
    await (await pool.connect(funder).fundReserve(e.handles[0], e.inputProof)).wait();
  });

  it("refuses to accrue against a draw that has not been revealed", async () => {
    await deposit(alice, 1000n);
    await pool.openDraw();
    await expect(pool.accrue(alice.address, 1)).to.be.revertedWithCustomError(
      pool,
      "DrawNotRevealed",
    );
  });

  it("is idempotent, and says so with a flag rather than a revert", async () => {
    await deposit(alice, 1000n);
    await mine(DAY);
    await pool.openDraw();
    await revealWith(1, 1n, 1_000_000n);

    await (await pool.accrue(alice.address, 1)).wait();
    expect(await pool.accrued(1, alice.address)).to.equal(true);

    const before = await readWinnings(alice);
    // A second call must not double-credit, and must not revert either: a keeper
    // retrying a chunk after a dropped receipt is normal, not an error.
    await (await pool.accrue(alice.address, 1)).wait();
    expect(await readWinnings(alice)).to.equal(before);
  });

  it("pays a winner and leaves a loser at zero", async () => {
    // Alice holds for a week, Bob joins at the end, so Alice's weight is far
    // larger. With totalWeight set high, only a very low threshold wins — and
    // thresholds are deterministic in R, so both outcomes are reachable.
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await deposit(bob, 1000n);
    await pool.openDraw();

    // A tiny total makes every threshold 0, and `gt` is strict, so anyone with
    // positive weight wins and anyone with zero weight does not.
    await revealWith(1, 7n, 1n);

    await (await pool.accrue(alice.address, 1)).wait();
    await (await pool.accrue(latecomer.address, 1)).wait();

    expect(await readWinnings(alice)).to.equal(PRIZE);
    expect(await readWinnings(latecomer)).to.equal(0n);
  });

  it("cannot pay an address that did not exist at the snapshot", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();
    await revealWith(1, 3n, 1n); // every threshold is 0 — the most generous case

    await mine(DAY);
    await deposit(latecomer, 5_000_000n); // the grinder's move, after the fact

    await (await pool.accrue(latecomer.address, 1)).wait();
    // Weight zero, and `gt` is strict, so no threshold can let this through.
    expect(await readWinnings(latecomer)).to.equal(0n);
  });

  it("folds a pending credit into the balance on the next ordinary deposit", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();
    await revealWith(1, 11n, 1n);
    await (await pool.accrue(alice.address, 1)).wait();

    // Won, but the balance has not moved yet — accrual deliberately writes no
    // observation, because the fold-in is free on a path that writes one anyway.
    expect(await readBalance(alice)).to.equal(1000n);

    await deposit(alice, 500n);
    expect(await readBalance(alice)).to.equal(1000n + PRIZE + 500n);
  });

  it("folds a pending credit in on a withdrawal too", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();
    await revealWith(1, 13n, 1n);
    await (await pool.accrue(alice.address, 1)).wait();

    await withdraw(alice, 200n);
    expect(await readBalance(alice)).to.equal(1000n + PRIZE - 200n);
  });

  it("gives the same answer with a cold cache as with a warm one", async () => {
    // The cache is an optimisation. Accruing draw 2 before draw 1 leaves draw 1's
    // snapshot uncached when draw 2 needs it, which must cost more and change
    // nothing. A keeper written against "each (user, draw) is independent" would
    // break if this were false.
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();
    await revealWith(1, 17n, 1n);

    await mine(7 * DAY);
    await deposit(bob, 10n); // gives the pool a second observation to snapshot
    await pool.openDraw();
    await revealWith(2, 19n, 1n);

    // Out of order on purpose.
    await (await pool.accrue(alice.address, 2)).wait();
    await (await pool.accrue(alice.address, 1)).wait();

    expect(await readWinnings(alice)).to.equal(PRIZE * 2n);
  });

  it("does not pay out more than the reserve holds", async () => {
    // Reserve 100,000 at a prize of 5,000 covers twenty wins. This pool cannot
    // mint balance it does not hold, so an exhausted reserve clamps the credit
    // rather than crediting a winner against nothing.
    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const small = (await Pool.deploy(await token.getAddress(), 0)) as unknown as PrizePoolHarness;
    await small.waitForDeployment();
    const addr = await small.getAddress();
    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice]) {
      await (await token.connect(who).setOperator(addr, until)).wait();
    }
    await (await small.setPrize(PRIZE)).wait();
    const e = await fhevm.createEncryptedInput(addr, funder.address).add64(1_000n).encrypt();
    await (await small.connect(funder).fundReserve(e.handles[0], e.inputProof)).wait();

    const d = await fhevm.createEncryptedInput(addr, alice.address).add64(1000n).encrypt();
    await (await small.connect(alice).deposit(d.handles[0], d.inputProof)).wait();
    await mine(DAY);
    await small.openDraw();
    await (await small.forceReveal(1, 23n, 1n)).wait();

    await (await small.accrue(alice.address, 1)).wait();
    const h = await small.winningsOf(alice.address);
    const won = h === ethers.ZeroHash ? 0n : await fhevm.userDecryptEuint(FhevmType.euint64, h, addr, alice);
    // The reserve holds 1,000 against a 5,000 prize, so nothing is payable.
    expect(won).to.equal(0n);
  });
});
