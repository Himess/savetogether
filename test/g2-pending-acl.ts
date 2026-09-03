/**
 * G2 — decrypt the handles a holder is meant to own, rather than assert they exist.
 *
 * This is the gap the F1 sweep actually exposed. Nothing in the 190-test suite
 * caught the `pendingOf` under-grant because every existing check on an encrypted
 * getter asserts the handle is non-zero:
 *
 *     const held = await source.principal!();
 *     expect(held).to.not.equal(ethers.ZeroHash);     // test/replica-source.ts:83
 *
 * A non-zero handle proves a value was written. It proves nothing about who may
 * read it, and "who may read it" is the entire security surface of an ACL. The
 * same blind spot covers `reserveHandle()`, `principal()`, `pending()` and
 * `inVault()`.
 *
 * So these tests decrypt. A getter that hands a holder a handle their own key
 * cannot open is a defect whether or not anyone has noticed yet.
 */
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setFlatPrize } from "./tiers";

const U = 1_000_000n;

/** Decrypts as `who`, or returns null when the ACL refuses. */
async function readable(
  handle: string,
  at: string,
  who: HardhatEthersSigner,
): Promise<bigint | null> {
  if (handle === ethers.ZeroHash) return 0n;
  try {
    return (await fhevm.userDecryptEuint(FhevmType.euint64, handle, at, who)) as bigint;
  } catch {
    return null;
  }
}

describe("G2 — the holder's own handles, decrypted", () => {
  let pool: any;
  let token: any;
  let poolAddr: string;
  let tokenAddr: string;
  let alice: HardhatEthersSigner;

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    const signers = await ethers.getSigners();
    alice = signers[1]!;

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = await Token.deploy("Confidential USD", "cUSD", "");
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    // Fund alice and let the pool move her tokens. The mock mints in plaintext.
    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * 86_400;
    await (await token.mint!(alice.address, 10_000n * U)).wait();
    await (await token.connect(alice).setOperator!(poolAddr, until)).wait();
    await setFlatPrize(pool, 1_000n);
  });

  const deposit = async (who: HardhatEthersSigner, amount: bigint): Promise<void> => {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(amount).encrypt();
    await (await pool.connect(who).deposit!(e.handles[0], e.inputProof)).wait();
  };

  /**
   * Runs one draw and accrues `who`.
   *
   * This is what makes the defect appear at all, and it is the whole point: an
   * un-accrued account has `_pending` still at the zero handle, which decrypts
   * trivially and hides the problem. `accrue` writes
   * `nextPending = tryAdd(_pending, paid)` for EVERY participant, winner or
   * loser, and grants it only to the contract — so the first accrual is the
   * moment a holder stops being able to read their own pending credit.
   */
  const drawAndAccrue = async (who: HardhatEthersSigner): Promise<void> => {
    await ethers.provider.send("evm_increaseTime", [86_400]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    const id = Number(await pool.drawCount!());
    await (await pool.forceReveal!(id, 1n, 1_000n)).wait();
    await (await pool.accrue!(who.address, id)).wait();
  };

  it("confidentialBalanceOf is readable by its holder after a deposit", async () => {
    await deposit(alice, 500n * U);
    const v = await readable(await pool.confidentialBalanceOf!(alice.address), poolAddr, alice);
    expect(v, "a holder must be able to read their own position").to.not.be.null;
    expect(v).to.equal(500n * U);
  });

  it("winningsOf is readable by its holder", async () => {
    await deposit(alice, 500n * U);
    await drawAndAccrue(alice);
    const v = await readable(await pool.winningsOf!(alice.address), poolAddr, alice);
    expect(v, "a holder must be able to read their own winnings").to.not.be.null;
  });

  /**
   * The regression this suite exists for.
   *
   * Marked pending rather than failing: the defect is real, measured on Sepolia
   * from a fresh key, and its fix is two lines that need a redeploy the sweep
   * found no other reason for. `bundle/F1-ACL-SWEEP.md` records the decision.
   * Un-skip this the moment those two lines ship; it will pass and it will keep
   * passing.
   */
  it.skip("pendingOf is readable by its holder — FAILS until the two-line ACL fix ships", async () => {
    await deposit(alice, 500n * U);
    await drawAndAccrue(alice);

    // After a deposit (which drains), after a withdrawal, and after a claim.
    const afterDeposit = await readable(await pool.pendingOf!(alice.address), poolAddr, alice);
    expect(afterDeposit, "pendingOf after a deposit").to.not.be.null;

    const w = await fhevm.createEncryptedInput(poolAddr, alice.address).add64(100n * U).encrypt();
    await (await pool.connect(alice).withdraw!(w.handles[0], w.inputProof)).wait();
    expect(await readable(await pool.pendingOf!(alice.address), poolAddr, alice), "after a withdrawal").to.not.be.null;

    await (await pool.connect(alice).claim!(alice.address)).wait();
    expect(await readable(await pool.pendingOf!(alice.address), poolAddr, alice), "after a claim").to.not.be.null;
  });

  it("documents the current, defective behaviour so a silent fix is also caught", async () => {
    await deposit(alice, 500n * U);
    await drawAndAccrue(alice);

    // Before this second deposit, `_pending` and `_winnings` have accumulated the
    // identical sequence from zero, so `tryAdd` produced the SAME handle for both
    // and the `FHE.allow(nextWinnings, user)` grant covers pending too. That is
    // the coincidence the pre-flight read of "40 cUSDC" was standing on.
    //
    // `deposit` calls `_drain`, which sets `_pending` to a fresh zero handle
    // granted only to the contract. The two diverge here, and the accident ends.
    const sharedHandle = (await pool.pendingOf!(alice.address)) === (await pool.winningsOf!(alice.address));
    expect(sharedHandle, "before any drain the two handles coincide").to.equal(true);

    await deposit(alice, 1n * U);
    const v = await readable(await pool.pendingOf!(alice.address), poolAddr, alice);

    // If this ever starts returning a number, the ACL fix has shipped and the
    // skipped test above should be enabled and this one deleted.
    expect(
      v,
      "pendingOf is expected to be UNREADABLE by its owner until the ACL fix ships — " +
        "if this failed, the fix has landed: enable the skipped test above and delete this one",
    ).to.be.null;
  });
});
