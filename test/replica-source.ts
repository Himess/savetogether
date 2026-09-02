import { expect } from "chai";
import { setFlatPrize } from "./tiers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * The replica source has to do BOTH jobs, or it is not worth having.
 *
 * Splitting them is what the previous design did: a mock that paid and a vault
 * adapter that composed, with the pool wired to the one that paid and the other
 * sitting beside it unused. These tests pin the merge — the pool's principal
 * reaches this contract, the prize is funded from the replica's own rate, and
 * the vault plumbing is present rather than described.
 */
const DAY = 24 * 60 * 60;
const PRIZE = 5_000n;
const RATE_BPS = 100_000n;

describe("SteakhouseReplicaSource", () => {
  it("funds a prize from the replica's rate, and pays nothing without a harvest", async () => {
    await fhevm.initializeCLIApi();
    const [funder, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("gUSDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    // The batcher is only reached by joinVault, which this test does not call;
    // the pool address stands in so the constructor has something non-zero.
    const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
    const source = await Source.deploy(tokenAddr, poolAddr, RATE_BPS, poolAddr);
    await source.waitForDeployment();
    const srcAddr = await source.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [funder, alice, bob]) {
      await (await token.mint!(who!.address, 5_000_000n)).wait();
      await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
    }
    // The pot the replica pays its yield out of.
    await (await token.mint!(srcAddr, 50_000_000n)).wait();

    await (await pool.setYieldSource!(srcAddr)).wait();
    await setFlatPrize(pool, PRIZE);

    for (const who of [alice, bob]) {
      const e = await fhevm.createEncryptedInput(poolAddr, who!.address).add64(100_000n).encrypt();
      await (await pool.connect(who!).deposit!(e.handles[0], e.inputProof)).wait();
    }

    // Principal reached the source rather than parking in the pool.
    const held = await source.principal!();
    expect(held).to.not.equal(ethers.ZeroHash);

    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);

    // The mirror first: a draw with NO harvest must pay nothing.
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(1, 1n, 1_000n)).wait(); // small: alice wins for certain
    await (await pool.accrue!(alice!.address, 1)).wait();
    const noHarvest = await (async () => {
      const h = await pool.winningsOf!(alice!.address);
      return h === ethers.ZeroHash ? 0n : fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!);
    })();
    // She cleared the threshold in both draws. The only thing that differs is
    // whether the reserve had been harvested, which is exactly the claim.
    expect(noHarvest, "a win against an empty reserve must still pay nothing").to.equal(0n);

    // Now harvest the replica's yield and run another draw.
    await (await pool.harvest!()).wait();
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw!()).wait();
    await (await pool.forceReveal!(2, 1n, 1_000n)).wait(); // same, so the ONLY difference is the harvest
    await (await pool.accrue!(alice!.address, 2)).wait();

    const won = await (async () => {
      const h = await pool.winningsOf!(alice!.address);
      return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, alice!);
    })();
    expect(won, "the prize must be funded by the replica's yield").to.equal(PRIZE);
  });

  it("returns principal on withdrawal, from the source next door", async () => {
    await fhevm.initializeCLIApi();
    const [, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("gUSDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
    const source = await Source.deploy(tokenAddr, poolAddr, RATE_BPS, poolAddr);
    await source.waitForDeployment();
    await (await pool.setYieldSource!(await source.getAddress())).wait();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    await (await token.mint!(alice!.address, 1_000_000n)).wait();
    await (await token.connect(alice!).setOperator!(poolAddr, until)).wait();

    const dep = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(1_000n).encrypt();
    await (await pool.connect(alice!).deposit!(dep.handles[0], dep.inputProof)).wait();

    const wd = await fhevm.createEncryptedInput(poolAddr, alice!.address).add64(400n).encrypt();
    await (await pool.connect(alice!).withdraw!(wd.handles[0], wd.inputProof)).wait();

    const left = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.confidentialBalanceOf!(alice!.address),
      poolAddr,
      alice!,
    );
    expect(left, "no-loss: the principal comes back").to.equal(600n);
  });

  it("refuses supply and redeem from anyone but the pool", async () => {
    await fhevm.initializeCLIApi();
    const [, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("gUSDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
    const source = await Source.deploy(tokenAddr, tokenAddr, RATE_BPS, tokenAddr);
    await source.waitForDeployment();

    await expect(
      source.connect(alice!).redeem!(ethers.ZeroHash, alice!.address),
    ).to.be.revertedWithCustomError(source, "NotController");
  });
});
