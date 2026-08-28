import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ConfidentialPrizePool, ERC7984Mock } from "../types";

const DAY = 24 * 60 * 60;

/**
 * The invariant that makes the inherited equality argument in findings.md §8.5
 * work, written down and pinned.
 *
 * §8.5 argues that the withdrawal clamp can borrow GhostKey's 180-transaction
 * result instead of buying its own, because the code has the same shape. That
 * argument rests on something that was, until now, emergent rather than stated:
 *
 *   **In a secret-bearing path, no storage write is conditional, and every path
 *   writes a fresh handle.**
 *
 * It holds today because `select`, `add` and `tryAdd` return a new handle
 * regardless of the encrypted condition, so the SSTORE cost does not vary with
 * the secret. Nothing enforces it.
 *
 * The way it breaks is quiet. A later optimisation that skips a write when
 * "nothing changed" — which cannot be decided from a ciphertext, but can be
 * decided from some public proxy for one — would void the equality, and no test
 * in the suite would notice. Hence these.
 *
 * The handle case is the sharper one. After a clamped withdrawal the balance
 * VALUE is unchanged, so if the stored handle were also unchanged, an observer
 * would read "this account was clamped" straight off the storage slot without
 * decrypting anything.
 */
describe("equality invariants", () => {
  let pool: ConfidentialPrizePool;
  let token: ERC7984Mock;
  let poolAddr: string;
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

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = (await Token.deploy("cUSDC", "cUSDC", "")) as unknown as ERC7984Mock;
    await token.waitForDeployment();

    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    pool = (await Pool.deploy(await token.getAddress())) as unknown as ConfidentialPrizePool;
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [alice, bob]) {
      await (await token.mint(who.address, 1_000_000n)).wait();
      await (await token.connect(who).setOperator(poolAddr, until)).wait();
    }
  });

  it("records an observation whether or not the withdrawal was clamped", async () => {
    await deposit(alice, 1000n);
    await deposit(bob, 1000n);
    const before = await pool.observationCount(alice.address);

    await withdraw(alice, 400n); // goes through
    await withdraw(bob, 5000n); // clamped to zero

    expect(await pool.observationCount(alice.address)).to.equal(before + 1n);
    expect(await pool.observationCount(bob.address)).to.equal(before + 1n);
  });

  it("writes a fresh handle even when the clamp left the value unchanged", async () => {
    await deposit(bob, 1000n);
    const before = (await pool.observationAt(bob.address, 0)).balance;

    await withdraw(bob, 5000n); // clamped: the VALUE does not move
    const after = (await pool.observationAt(bob.address, 1)).balance;

    // The value is the same...
    const v = await fhevm.userDecryptEuint(FhevmType.euint64, after, poolAddr, bob);
    expect(v).to.equal(1000n);

    // ...and the handle must not be, or the storage slot itself announces the clamp.
    expect(after).to.not.equal(before);
  });

  it("burns the same gas whether the withdrawal moved funds or nothing", async () => {
    // Both accounts hold exactly the same balance and take the same code path;
    // only the encrypted comparison differs. Any gap here is a conditional write.
    await deposit(alice, 1000n);
    await deposit(bob, 1000n);

    const moved = await withdraw(alice, 400n);
    const clamped = await withdraw(bob, 5000n);

    const gap = moved!.gasUsed - clamped!.gasUsed;
    const abs = gap < 0n ? -gap : gap;
    console.log(`      moved ${moved!.gasUsed}  clamped ${clamped!.gasUsed}  gap ${gap}`);

    // Not asserted as exact equality: intrinsic calldata cost depends on the
    // zero-byte count of two different ciphertexts, which has nothing to do with
    // the secret. A conditional SSTORE would show up as thousands, not tens.
    expect(abs, `gas gap ${gap} between a moved and a clamped withdrawal`).to.be.lessThan(1000n);
  });

  it("keeps the aggregate observation count independent of the outcome", async () => {
    await deposit(alice, 1000n);
    const before = await pool.totalObservationCount();
    await withdraw(alice, 5000n); // clamped
    expect(await pool.totalObservationCount()).to.equal(before + 1n);
  });
});
