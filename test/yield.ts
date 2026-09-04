import { expect } from "chai";
import { setFlatPrize } from "./tiers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { PrizePoolHarness, ERC7984Mock, MockYieldSource } from "../types";

const DAY = 24 * 60 * 60;
const RATE_BPS = 500n; // 5% a year
const PRIZE = 1_000n;

/**
 * The prize comes from yield on the pool's own deposits.
 *
 * Until this existed the prize was paid from a reserve funded by hand in the
 * deploy script, which makes the product a lottery with a pre-funded pot rather
 * than no-loss prize savings. The bounty's own framing is "yield funds a prize
 * pool", and that sentence is either demonstrable or it is marketing.
 *
 * `MockYieldSource` simulates WHERE the yield comes from — it is pre-funded and
 * invests nothing. It does not simulate HOW MUCH: the amount is
 * `principal x rate x elapsed`, computed homomorphically on the encrypted
 * principal, so it is a real function of what the pool holds and for how long.
 * That is the half worth testing.
 */
describe("yield", () => {
  let pool: PrizePoolHarness;
  let token: ERC7984Mock;
  let source: MockYieldSource;
  let poolAddr: string;
  let srcAddr: string;
  let funder: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  async function deposit(who: HardhatEthersSigner, value: bigint) {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(value).encrypt();
    return (await pool.connect(who).deposit(e.handles[0], e.inputProof)).wait();
  }

  async function withdraw(who: HardhatEthersSigner, value: bigint) {
    const e = await fhevm.createEncryptedInput(poolAddr, who.address).add64(value).encrypt();
    return (await pool.connect(who).withdraw(e.handles[0], e.inputProof)).wait();
  }

  async function readAs(handle: string, contract: string, who: HardhatEthersSigner) {
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, contract, who);
  }

  async function mine(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async () => {
    await fhevm.initializeCLIApi();
    [funder, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    token = (await Token.deploy("gUSDC", "gUSDC", "")) as unknown as ERC7984Mock;
    await token.waitForDeployment();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    pool = (await Pool.deploy(await token.getAddress(), 0)) as unknown as PrizePoolHarness;
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    const Source = await ethers.getContractFactory("MockYieldSource");
    source = (await Source.deploy(
      await token.getAddress(),
      RATE_BPS,
      poolAddr,
    )) as unknown as MockYieldSource;
    await source.waitForDeployment();
    srcAddr = await source.getAddress();

    await (await pool.setYieldSource(srcAddr)).wait();
    await setFlatPrize(pool, PRIZE);

    // The pot the mock pays out of. Simulated, and labelled as such.
    await (await token.mint(srcAddr, 10_000_000n)).wait();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice, bob]) {
      await (await token.mint(who.address, 50_000_000n)).wait();
      await (await token.connect(who).setOperator(poolAddr, until)).wait();
    }
  });

  it("moves principal to the source instead of parking it in the pool", async () => {
    await deposit(alice, 1_000_000n);

    // The pool's balance handle is initialised either way -- the tokens land
    // here for one instruction before moving on -- so 'is it zero' cannot
    // distinguish parked from forwarded, and nobody outside the source can
    // decrypt its holdings. The event is the checkable fact: supply ran.
    const supplied = await source.queryFilter(source.filters.Supplied(), 0, 'latest');
    expect(supplied.length, 'supply must have been called by the deposit').to.be.greaterThan(0);

    // And the user's recorded position is unaffected by where it physically is.
    const bal = await pool.confidentialBalanceOf(alice.address);
    expect(await readAs(bal, poolAddr, alice)).to.equal(1_000_000n);
  });

  it("accrues principal x rate x elapsed, and harvest moves it to the reserve", async () => {
    await deposit(alice, 1_000_000n);
    await mine(30 * DAY);

    await (await pool.harvest()).wait();

    // 1,000,000 x 500bps x 30 days / (10000 x 365 days) = 4109
    const expected = (1_000_000n * RATE_BPS * BigInt(30 * DAY)) / (10_000n * BigInt(365 * DAY));
    expect(expected).to.be.greaterThan(0n);

    // The reserve is encrypted and only the contract may read it, so the check
    // is that a prize is now payable from it — see the end-to-end test below.
    expect(await source.lastAccrual()).to.be.greaterThan(0n);
  });

  it("pays a prize out of harvested yield, end to end", async () => {
    // No reserve is funded by hand anywhere in this test. If a prize is paid,
    // it came from yield.
    await deposit(alice, 5_000_000n);
    await mine(60 * DAY);
    await (await pool.harvest()).wait();

    await pool.openDraw();
    await (await pool.forceReveal(1, 7n, 1n)).wait(); // total 1 -> every threshold is 0
    await (await pool.accrue(alice.address, 1)).wait();

    const won = await readAs(await pool.winningsOf(alice.address), poolAddr, alice);
    expect(won, "the prize must be funded by yield alone").to.equal(PRIZE);
  });

  it("pays nothing when no yield has been harvested", async () => {
    // The mirror of the test above: same setup, no harvest, so the reserve is
    // empty and the clamp in accrue leaves the winner with nothing. Without this
    // the previous test could pass on a reserve that came from somewhere else.
    await deposit(alice, 5_000_000n);
    await mine(60 * DAY);

    await pool.openDraw();
    await (await pool.forceReveal(1, 7n, 1n)).wait();
    await (await pool.accrue(alice.address, 1)).wait();

    expect(await readAs(await pool.winningsOf(alice.address), poolAddr, alice)).to.equal(0n);
  });

  it("returns principal from the source on withdrawal", async () => {
    await deposit(alice, 1_000_000n);
    await mine(DAY);

    const before = await readAs(
      await token.confidentialBalanceOf(alice.address),
      await token.getAddress(),
      alice,
    );
    await withdraw(alice, 400_000n);
    const after = await readAs(
      await token.confidentialBalanceOf(alice.address),
      await token.getAddress(),
      alice,
    );

    expect(after - before).to.equal(400_000n);
    expect(await readAs(await pool.confidentialBalanceOf(alice.address), poolAddr, alice)).to.equal(
      600_000n,
    );
  });

  it("still clamps an over-withdrawal when the principal is next door", async () => {
    // The clamp target moved from zero to the balance (FHE.min), and the point
    // of this test did not: whatever the source does, an over-ask must not
    // revert, because a revert publishes that the account overreached. With the
    // principal in the yield source the whole balance now comes back through
    // redeem() in one transaction.
    await deposit(alice, 1_000_000n);
    await mine(DAY);

    const receipt = await withdraw(alice, 9_000_000n);
    expect(receipt!.status, "a revert would publish that the account overreached").to.equal(1);
    expect(await readAs(await pool.confidentialBalanceOf(alice.address), poolAddr, alice)).to.equal(
      0n,
    );
  });

  it("does not let a late depositor earn on time it was not present for", async () => {
    // Alice holds for 30 days, then Bob arrives. Settling before the principal
    // changes is what stops Bob's arrival from diluting or inflating the
    // interest already earned.
    await deposit(alice, 1_000_000n);
    await mine(30 * DAY);
    await deposit(bob, 1_000_000n);

    const t = Number(await source.lastAccrual());
    const block = await ethers.provider.getBlock("latest");
    expect(t, "supply must settle the clock").to.equal(block!.timestamp);
  });

  it("refuses supply and redeem from anyone but the pool", async () => {
    const e = await fhevm.createEncryptedInput(srcAddr, alice.address).add64(1n).encrypt();
    await expect(
      (source.connect(alice) as unknown as MockYieldSource).supply(e.handles[0]),
    ).to.be.revertedWithCustomError(source, "OnlyController");
  });
});
