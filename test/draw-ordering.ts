import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ConfidentialPrizePool, ERC7984Mock } from "../types";

const DAY = 24 * 60 * 60;

/**
 * The draw's ordering invariant, from findings.md A6.
 *
 *   freeze weights  ->  draw R  ->  reveal R
 *
 * Getting this backwards is not a degradation, it is a total break. The
 * per-user threshold is `keccak256(R, address)`, a pure function of public
 * inputs, so anyone who learns R while the eligible set is still open can grind
 * addresses until one yields a near-zero threshold and win with dust.
 *
 * The defence has two halves and both are tested here: `openDraw` freezes and
 * draws atomically, and an account with no history before the snapshot carries
 * zero weight — which `FHE.gt`, being strict, can never turn into a win.
 *
 * `revealDraw` needs real KMS signatures and is exercised on Sepolia. What is
 * testable locally is that its replay guard runs BEFORE `checkSignatures`, which
 * is the half that matters: `checkSignatures` has no replay protection of its
 * own, and re-finalising is how a keeper would grind R.
 */
describe("draw ordering", () => {
  let pool: ConfidentialPrizePool;
  let token: ERC7984Mock;
  let poolAddr: string;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let latecomer: HardhatEthersSigner;

  async function deposit(who: HardhatEthersSigner, value: bigint) {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(value).encrypt();
    return (await pool.connect(who).deposit(e.handles[0], e.inputProof)).wait();
  }

  async function readWeight(drawId: number, who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).weightFor(drawId, who.address)).wait();
    const handle = await pool.connect(who).weightFor.staticCall(drawId, who.address);
    return fhevm.userDecryptEuint(FhevmType.euint128, handle, poolAddr, who);
  }

  async function mine(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [, alice, bob, latecomer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = (await Token.deploy("cUSDC", "cUSDC", "")) as unknown as ERC7984Mock;
    await token.waitForDeployment();

    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    pool = (await Pool.deploy(await token.getAddress())) as unknown as ConfidentialPrizePool;
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [alice, bob, latecomer]) {
      await (await token.mint(who.address, 1_000_000n)).wait();
      await (await token.connect(who).setOperator(poolAddr, until)).wait();
    }
  });

  it("refuses to open a draw on an empty pool rather than handing the KMS a null handle", async () => {
    // GhostLend lost an epoch machine to exactly this: makePubliclyDecryptable
    // on a handle that was never initialised, rejected by the KMS, unrecoverable.
    await expect(pool.openDraw()).to.be.revertedWithCustomError(pool, "NothingStaked");
  });

  it("freezes the snapshot and draws R in one transaction", async () => {
    await deposit(alice, 1000n);
    await mine(DAY);

    const tx = await pool.openDraw();
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);

    expect(await pool.drawCount()).to.equal(1n);
    const d = await pool.drawAt(1);
    expect(d.status).to.equal(1n); // Open
    expect(d.snapshotAt).to.equal(BigInt(block!.timestamp));
    expect(d.periodStart).to.equal(await pool.genesis());
    // R exists as a handle already — it was drawn in the same transaction that
    // froze the snapshot, so there is no window in which it could be known first.
    expect(d.encR).to.not.equal(ethers.ZeroHash);
  });

  it("will not open a second draw while the first is unresolved", async () => {
    await deposit(alice, 1000n);
    await pool.openDraw();
    await expect(pool.openDraw()).to.be.revertedWithCustomError(pool, "PreviousDrawUnresolved");
  });

  it("refuses to compute a threshold before R is public", async () => {
    await deposit(alice, 1000n);
    await pool.openDraw();
    await expect(pool.thresholdFor(1, alice.address)).to.be.revertedWithCustomError(
      pool,
      "DrawNotRevealed",
    );
  });

  it("checks the replay guard before it checks signatures", async () => {
    // Draw 99 was never opened. If the status check ran after checkSignatures,
    // this would fail on signature verification instead — and a draw that has
    // already been finalised could be finalised again, which is how a keeper
    // grinds R.
    await expect(pool.revealDraw(99, "0x", "0x")).to.be.revertedWithCustomError(
      pool,
      "DrawNotOpen",
    );
  });

  it("gives an address that did not exist at the snapshot exactly zero weight", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();

    // The grinder's move: deposit after the snapshot, hoping the threshold on a
    // freshly chosen address is favourable.
    await mine(DAY);
    await deposit(latecomer, 1_000_000n);

    expect(await readWeight(1, latecomer)).to.equal(0n);
    expect(await readWeight(1, alice)).to.be.greaterThan(0n);
  });

  it("does not let a post-snapshot deposit change a weight that was already frozen", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await pool.openDraw();
    const frozen = await readWeight(1, alice);

    await mine(DAY);
    await deposit(alice, 500_000n);

    expect(await readWeight(1, alice)).to.equal(frozen);
  });

  it("weighs a mid-period joiner below a full-period holder", async () => {
    await deposit(alice, 1000n);
    await mine(7 * DAY);
    await deposit(bob, 1000n);
    await mine(DAY);
    await pool.openDraw();

    const a = await readWeight(1, alice);
    const b = await readWeight(1, bob);
    expect(a).to.be.greaterThan(b);
    expect(b).to.be.greaterThan(0n);
  });
});
