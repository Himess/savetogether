import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { setFlatPrize } from "./tiers";

/**
 * CD — the two invariants this redeploy exists to add.
 *
 * 1. `accrueMany` must pay for accruals it PERFORMED, not for the length of the
 *    array it was handed.
 * 2. Every handle this contract hands out must be decryptable by the address it
 *    is handed to — asserted on chain, not by decrypting over a network.
 *
 * The first was live and extractable on the deployed pool. `accrue` returns
 * early for an address already settled in that draw, `_payKeeper` only checked
 * the array was non-empty, the fee goes to `msg.sender`, and `accrueMany` is
 * external with no modifier. So `accrueMany([alreadySettled], drawId)` collected
 * the full fee for doing nothing, repeatably, for a fraction of a cent of gas.
 *
 * The B4 suite had two cases and neither called `accrueMany` twice, so both
 * passed with or without the guard. That is the gap this file closes: the test
 * for a defect has to be able to FAIL because of it.
 */
const DAY = 24 * 60 * 60;
const PRIZE = 1_000n;
const FEE = 50n;

async function base() {
  await fhevm.initializeCLIApi();
  const [owner, alice, stranger] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("ERC7984Mock");
  const token = await Token.deploy("cUSDC", "cUSDC", "");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const Pool = await ethers.getContractFactory("PrizePoolHarness");
  const pool = await Pool.deploy(tokenAddr, 0);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  for (const who of [owner, alice, stranger]) {
    await (await token.mint!(who!.address, 1_000_000n)).wait();
    await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
  }
  await setFlatPrize(pool, PRIZE);
  await (await pool.setKeeperFee!(FEE)).wait();

  const seed = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(100_000n).encrypt();
  await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();
  const pot = await fhevm.createEncryptedInput(poolAddr, owner!.address).add64(10_000n).encrypt();
  await (await pool.fundFeePot!(pot.handles[0], pot.inputProof)).wait();

  const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(10_000n).encrypt();
  await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

  await ethers.provider.send("evm_increaseTime", [DAY]);
  await ethers.provider.send("evm_mine", []);
  await (await pool.openDraw!()).wait();
  await (await pool.forceReveal!(1, 7n, 1n)).wait();

  return { owner, alice, stranger, token, tokenAddr, pool, poolAddr };
}

const bal = async (token: any, tokenAddr: string, who: any): Promise<bigint> => {
  const h = await token.confidentialBalanceOf!(who.address);
  if (h === ethers.ZeroHash) return 0n;
  return (await fhevm.userDecryptEuint(FhevmType.euint64, h, tokenAddr, who)) as bigint;
};

describe("CD — the keeper is paid for work, not for calling", () => {
  it("pays once for one accrual, however many times it is asked again", async () => {
    const { owner, alice, token, tokenAddr, pool } = await base();

    const start = await bal(token, tokenAddr, owner);
    await (await pool.accrueMany!([alice!.address], 1)).wait();
    const afterFirst = await bal(token, tokenAddr, owner);
    expect(afterFirst - start, "the first call did the work and is paid").to.equal(FEE);

    // The same address, already settled. `accrue` returns early, so this call
    // performs no accrual — and must therefore earn nothing.
    await (await pool.accrueMany!([alice!.address], 1)).wait();
    await (await pool.accrueMany!([alice!.address], 1)).wait();
    const afterRepeats = await bal(token, tokenAddr, owner);

    expect(afterRepeats, "repeat calls do no work and must not be paid").to.equal(afterFirst);
  });

  it("cannot be drained by a stranger replaying a settled address", async () => {
    const { alice, stranger, token, tokenAddr, pool } = await base();

    await (await pool.accrueMany!([alice!.address], 1)).wait();

    const start = await bal(token, tokenAddr, stranger);
    for (let i = 0; i < 5; i++) {
      await (await pool.connect(stranger!).accrueMany!([alice!.address], 1)).wait();
    }
    const end = await bal(token, tokenAddr, stranger);

    // Before the guard this was 5 × FEE to anybody who asked.
    expect(end - start, "an unprivileged caller earns nothing for no work").to.equal(0n);
  });

  it("still pays in full for a batch where every address is fresh", async () => {
    const { owner, alice, stranger, token, tokenAddr, pool, poolAddr } = await base();

    const e = await fhevm.createEncryptedInput(poolAddr, stranger!.address).add64(5_000n).encrypt();
    await (await pool.connect(stranger!).deposit!(e.handles[0], e.inputProof)).wait();

    const start = await bal(token, tokenAddr, owner);
    await (await pool.accrueMany!([alice!.address, stranger!.address], 1)).wait();
    const end = await bal(token, tokenAddr, owner);

    // Two accruals performed. The fee is per call in this contract, so the
    // assertion is that a genuine batch is not penalised by the guard.
    expect(end - start, "a real batch is still paid").to.equal(FEE);
  });
});

describe("CD — every handle is readable by the address it is handed to", () => {
  /**
   * The invariant F1 had to find over a network, asserted on chain.
   *
   * F1's sweep decrypted ten externally-readable handles from a fresh Sepolia
   * key and found `pendingOf` unreadable by its own owner. Nothing in the suite
   * caught it because every existing assertion on those handles checked the
   * handle was non-zero, which proves a value was WRITTEN and says nothing about
   * who may read it — and who may read it is the whole security surface of an
   * ACL.
   *
   * `FHE.isUserDecryptable` turns that into a pure view: no relayer, no keys, no
   * network. Any getter added later that forgets its grant fails here.
   */
  it("pendingOf, winningsOf and confidentialBalanceOf all pass isUserDecryptable", async () => {
    const { alice, pool, poolAddr } = await base();

    await (await pool.accrueMany!([alice!.address], 1)).wait();

    // A deposit drains pending into the balance, which is the path that used to
    // leave `_pending` holding a fresh zero granted only to the contract.
    const e = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(1n).encrypt();
    await (await pool.connect(alice!).deposit!(e.handles[0], e.inputProof)).wait();

    for (const getter of ["pendingOf", "winningsOf", "confidentialBalanceOf"] as const) {
      const handle = await (pool as any)[getter]!(alice!.address);
      if (handle === ethers.ZeroHash) continue; // a real zero has nothing to grant
      expect(
        await pool.isReadableBy!(handle, alice!.address),
        `${getter} must be decryptable by its own holder`,
      ).to.equal(true);
    }
  });
});
