import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * W1 — what withdrawal does when half the principal is in Zama's vault.
 *
 * `joinVault` moves principal into a batch and this contract does not unwind
 * shares on demand, so `redeem` can only pay from what is left behind. The
 * rubric's most load-bearing line sits under this: *principal is withdrawable at
 * any time*. The redeploy changed the conditions under it, so the conditions get
 * measured rather than argued.
 *
 * The claim these tests pin is narrower and stronger than "withdrawal always
 * works": **nothing is ever lost.** A short buffer costs you liquidity for one
 * transaction, not principal — `withdraw` returns whatever the source declined
 * to move straight back to your balance in the same transaction, so the money is
 * still yours and the next withdrawal can take it.
 *
 * Asserted on DELTAS throughout. `smoke-cusdc.ts` once asserted an absolute and
 * passed for the wrong reason.
 */
const DAY = 24 * 60 * 60;
const RATE_BPS = 100_000n;

/** Sets up pool + replica + batcher with no pot, so the buffer is exactly principal. */
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

  const Batcher = await ethers.getContractFactory("MockDepositBatcher");
  const batcher = await Batcher.deploy();
  await batcher.waitForDeployment();

  const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
  const source = await Source.deploy(tokenAddr, await batcher.getAddress(), RATE_BPS, poolAddr);
  await source.waitForDeployment();

  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  await (await token.mint!(alice!.address, 1_000_000n)).wait();
  await (await token.connect(alice!).setOperator!(poolAddr, until)).wait();
  await (await pool.setYieldSource!(await source.getAddress())).wait();

  return { deployer, alice, token, pool, poolAddr, source };
}

/** Alice's pool balance in the clear. She owns the handle, so she can read it. */
async function position(pool: any, poolAddr: string, alice: any): Promise<bigint> {
  const h: string = await pool.confidentialBalanceOf!(alice.address);
  if (h === ethers.ZeroHash) return 0n;
  return (await fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice)) as bigint;
}

async function wallet(token: any, tokenAddr: string, alice: any): Promise<bigint> {
  const h: string = await token.confidentialBalanceOf!(alice.address);
  if (h === ethers.ZeroHash) return 0n;
  return (await fhevm.userDecryptEuint(FhevmType.euint64, h, tokenAddr, alice)) as bigint;
}

async function deposit(pool: any, poolAddr: string, who: any, amount: bigint): Promise<void> {
  const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(amount).encrypt();
  await (await pool.connect(who).deposit!(e.handles[0], e.inputProof)).wait();
}

async function withdraw(pool: any, poolAddr: string, who: any, amount: bigint): Promise<void> {
  const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(amount).encrypt();
  await (await pool.connect(who).withdraw!(e.handles[0], e.inputProof)).wait();
}

describe("W1 — withdrawal with principal in the vault", () => {
  it("a round trip returns the position to exactly where it started", async () => {
    const { alice, pool, poolAddr } = await setup();

    await deposit(pool, poolAddr, alice, 100_000n);
    const before = await position(pool, poolAddr, alice);

    await deposit(pool, poolAddr, alice, 40_000n);
    const afterDeposit = await position(pool, poolAddr, alice);
    expect(afterDeposit - before).to.equal(40_000n, "deposit delta");

    await withdraw(pool, poolAddr, alice, 40_000n);
    const afterWithdraw = await position(pool, poolAddr, alice);
    expect(afterWithdraw - before).to.equal(0n, "round-trip delta must be zero");
  });

  it("withdraws in full while the buffer covers it, even after joinVault", async () => {
    const { alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();

    await deposit(pool, poolAddr, alice, 100_000n);
    await (await source.joinVault!()).wait(); // half the principal leaves

    const posBefore = await position(pool, poolAddr, alice);
    const walBefore = await wallet(token, tokenAddr, alice);

    // Half is still here, so half comes out whole.
    await withdraw(pool, poolAddr, alice, 50_000n);

    expect((await position(pool, poolAddr, alice)) - posBefore).to.equal(-50_000n, "position falls by the full amount");
    expect((await wallet(token, tokenAddr, alice)) - walBefore).to.equal(50_000n, "wallet rises by the full amount");
  });

  /**
   * The measured behaviour, and it is NOT the partial payment I expected.
   *
   * ERC-7984's transfer is all-or-nothing: `tryDecrease` on the source's balance
   * either succeeds for the whole amount or moves zero. So asking for more than
   * the buffer holds does not pay out the buffer — it pays out NOTHING, and the
   * transaction still succeeds.
   *
   * That is better for the rubric's line and worse for the user. Better,
   * because principal cannot be partially stranded: your position is untouched
   * and every unit is still yours. Worse, because the failure is silent and now
   * has a SECOND cause the interface never mentioned — "more than the buffer
   * holds" looks exactly like "more than you hold".
   */
  it("moves NOTHING when the buffer is short, and loses nothing either", async () => {
    const { alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();

    await deposit(pool, poolAddr, alice, 100_000n);
    await (await source.joinVault!()).wait(); // 50,000 leaves, 50,000 remains

    const posBefore = await position(pool, poolAddr, alice);
    const walBefore = await wallet(token, tokenAddr, alice);
    expect(posBefore).to.equal(100_000n);

    await withdraw(pool, poolAddr, alice, 100_000n);

    const paid = (await wallet(token, tokenAddr, alice)) - walBefore;
    const posAfter = await position(pool, poolAddr, alice);

    expect(paid).to.equal(0n, "all-or-nothing: the buffer is not paid out piecewise");
    expect(posAfter).to.equal(posBefore, "the position is untouched — nothing is lost");
  });

  it("pays in full once the buffer covers the request", async () => {
    const { deployer, alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();
    const srcAddr = await source.getAddress();

    await deposit(pool, poolAddr, alice, 100_000n);
    await (await source.joinVault!()).wait();
    await withdraw(pool, poolAddr, alice, 100_000n); // moves nothing
    expect(await position(pool, poolAddr, alice)).to.equal(100_000n);

    // A batch settling, or anyone topping the source up, refills the buffer.
    await (await token.connect(deployer!).mint!(srcAddr, 50_000n)).wait();

    const walBefore = await wallet(token, tokenAddr, alice);
    await withdraw(pool, poolAddr, alice, 100_000n);

    expect((await wallet(token, tokenAddr, alice)) - walBefore).to.equal(100_000n, "the whole position comes out");
    expect(await position(pool, poolAddr, alice)).to.equal(0n, "and it is empty");
  });

  it("smaller asks still succeed while a larger one cannot", async () => {
    const { alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();

    await deposit(pool, poolAddr, alice, 100_000n);
    await (await source.joinVault!()).wait(); // buffer is 50,000

    // This is the practical answer for a user who hits the wall: ask for less.
    const walBefore = await wallet(token, tokenAddr, alice);
    await withdraw(pool, poolAddr, alice, 50_000n);
    expect((await wallet(token, tokenAddr, alice)) - walBefore).to.equal(50_000n, "the buffer is withdrawable in one ask");
    expect(await position(pool, poolAddr, alice)).to.equal(50_000n, "the rest waits for the batch");
  });
});

/**
 * Found while measuring the live buffer for W1.
 *
 * `joinVault` sends `FHE.shr(_principal, 1)` and does NOT decrement
 * `_principal`, so the "half" is half of the same number every time. It is also
 * permissionless. Two calls therefore move the whole principal; enough calls
 * move whatever else the contract holds, including the pot prizes are paid from.
 *
 * Nothing is stolen — the batcher credits this contract as the beneficiary and
 * `claimShares` recovers the position — but liquidity is the thing being spent,
 * and the rubric's load-bearing line is about liquidity: *principal is
 * withdrawable at any time.*
 */
describe("B2 — joinVault is bounded, so repeating it converges", () => {
  it("moves half of what REMAINS, not half of the original, on a second call", async () => {
    const { alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();

    await deposit(pool, poolAddr, alice, 100_000n);

    await (await source.joinVault!()).wait(); // 50,000 out, 50,000 left
    await (await source.joinVault!()).wait(); // 25,000 out, 25,000 left

    const walBefore = await wallet(token, tokenAddr, alice);
    await withdraw(pool, poolAddr, alice, 25_000n);

    // Before B2 the second call moved another 50,000 and the buffer was empty,
    // so this withdrawal paid nothing. Bounded, the second call moves half of
    // the 50,000 that is left, so 25,000 is still here and 50,000 comes out over
    // two asks rather than none.
    expect((await wallet(token, tokenAddr, alice)) - walBefore).to.equal(
      25_000n,
      "half of the remainder stayed behind, so a smaller ask still pays",
    );
    expect(await position(pool, poolAddr, alice)).to.equal(75_000n);
  });

  it("never empties the buffer however many times it is called", async () => {
    const { alice, token, pool, poolAddr, source } = await setup();
    const tokenAddr = await token.getAddress();
    await deposit(pool, poolAddr, alice, 100_000n);

    // Permissionless and unbounded in COUNT — the bound is on the amount.
    for (let i = 0; i < 8; i++) await (await source.joinVault!()).wait();

    const walBefore = await wallet(token, tokenAddr, alice);
    await withdraw(pool, poolAddr, alice, 300n);
    expect((await wallet(token, tokenAddr, alice)) - walBefore).to.equal(
      300n,
      "eight joins later there is still liquidity, because each takes half of the rest",
    );
  });
});
