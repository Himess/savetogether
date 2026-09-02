import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { setFlatPrize } from "./tiers";

/**
 * AA1 — can a stranger read someone else's encrypted weight?
 *
 * `weightFor(drawId, user)` and `cumulativeAt(account, target)` both take the
 * SUBJECT as a parameter and grant decryption to `msg.sender`. Nothing requires
 * the two to be the same address.
 *
 * A direct EOA call cannot capture the return value — a receipt does not carry
 * one — which is exactly why this survived: it is not reachable by hand, only
 * through a contract. So this test uses a contract.
 *
 * `totalWeight` is published at every reveal. A weight divided by it is a pool
 * share, which is the primary secret the contract exists to keep.
 *
 * The assertions are written so they FAIL while the leak exists and pass once it
 * is closed. They are the regression, not the report.
 */
const DAY = 24 * 60 * 60;

describe("AA1 — a stranger must not be able to read another depositor's weight", () => {
  it("weightFor: a contract cannot hand a victim's weight to an attacker", async () => {
    await fhevm.initializeCLIApi();
    const [deployer, victim, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    await (await token.mint!(victim!.address, 1_000_000n)).wait();
    await (await token.connect(victim!).setOperator!(poolAddr, until)).wait();
    await setFlatPrize(pool, 1_000n);

    // A balance nobody else is supposed to learn.
    const SECRET = 137_000n;
    const e = await fhevm.createEncryptedInput(poolAddr, victim!.address).add64(SECRET).encrypt();
    await (await pool.connect(victim!).deposit!(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();

    const Attacker = await ethers.getContractFactory("WeightLeakAttacker");
    const atk = await Attacker.connect(attacker!).deploy();
    await atk.waitForDeployment();
    const atkAddr = await atk.getAddress();

    // The attack has two places it can fail, and either is a pass: the
    // re-delegation reverts because the pool never granted the CONTRACT
    // anything, or it succeeds and the decryption is refused.
    let leaked: bigint | null = null;
    let reverted = false;
    try {
      await (await atk.connect(attacker!).stealWeight!(poolAddr, 1, victim!.address, attacker!.address)).wait();
    } catch (e) {
      reverted = true;
      console.log("      attack reverted:", String(e).split("\n")[0].slice(0, 96));
    }
    if (!reverted) {
      const handle: string = await atk.stolen!();
      try {
        leaked = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, atkAddr, attacker!)) as bigint;
      } catch {
        leaked = null;
      }
    }

    if (leaked !== null) {
      // The window is one day, so weight = balance x seconds. Recovering the
      // balance from it is division by a public number.
      console.log(`      LEAKED weight ${leaked} -> balance ${leaked / BigInt(DAY)} (secret was ${SECRET})`);
    }
    expect(leaked === null).to.equal(true, "a stranger decrypted another depositor's weight");
  });

  it("cumulativeAt: the same, and over any window the attacker chooses", async () => {
    await fhevm.initializeCLIApi();
    const [deployer, victim, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    await (await token.mint!(victim!.address, 1_000_000n)).wait();
    await (await token.connect(victim!).setOperator!(poolAddr, until)).wait();
    await setFlatPrize(pool, 1_000n);

    const SECRET = 91_000n;
    const e = await fhevm.createEncryptedInput(poolAddr, victim!.address).add64(SECRET).encrypt();
    await (await pool.connect(victim!).deposit!(e.handles[0], e.inputProof)).wait();

    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);

    const Attacker = await ethers.getContractFactory("WeightLeakAttacker");
    const atk = await Attacker.connect(attacker!).deploy();
    await atk.waitForDeployment();
    const atkAddr = await atk.getAddress();

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    let leaked: bigint | null = null;
    let reverted = false;
    try {
      await (await atk.connect(attacker!).stealCumulative!(poolAddr, victim!.address, now, attacker!.address)).wait();
    } catch (e) {
      reverted = true;
      console.log("      attack reverted:", String(e).split("\n")[0].slice(0, 96));
    }
    if (!reverted) {
      const handle: string = await atk.stolen!();
      try {
        leaked = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, atkAddr, attacker!)) as bigint;
      } catch {
        leaked = null;
      }
    }
    if (leaked !== null) console.log(`      LEAKED cumulative ${leaked} (victim's balance was ${SECRET})`);
    expect(leaked === null).to.equal(true, "a stranger decrypted another depositor's cumulative");
  });

  it("the subject can still read their own weight — the fix must not break this", async () => {
    await fhevm.initializeCLIApi();
    const [, victim] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    await (await token.mint!(victim!.address, 1_000_000n)).wait();
    await (await token.connect(victim!).setOperator!(poolAddr, until)).wait();
    await setFlatPrize(pool, 1_000n);

    const AMOUNT = 50_000n;
    const e = await fhevm.createEncryptedInput(poolAddr, victim!.address).add64(AMOUNT).encrypt();
    await (await pool.connect(victim!).deposit!(e.handles[0], e.inputProof)).wait();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();

    await (await pool.connect(victim!).weightFor!(1, victim!.address)).wait();
    const handle: string = await pool.connect(victim!).weightFor!.staticCall(1, victim!.address);
    const mine = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, poolAddr, victim!)) as bigint;

    expect(mine).to.be.greaterThan(0n, "the subject must still be able to audit their own draw");
  });
});
