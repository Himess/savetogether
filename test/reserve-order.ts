import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * When the reserve cannot cover every winner, WHO gets paid?
 *
 * `accrue` awards the prize only if `tryDecrease(_reserve, credit)` succeeds, so
 * a reserve holding one prize pays the first winner it is asked about and
 * credits every later one zero. The order is chosen by whoever calls
 * `accrueMany`, which in this deployment is the keeper.
 *
 * That makes the keeper a participant in the outcome under a condition it does
 * not control and cannot see — and the failure is silent on both sides, because
 * a declined `tryDecrease` produces exactly what losing produces.
 *
 * These tests do not assert that the behaviour is wrong. They pin what it IS,
 * because it is the kind of property that should be a decision rather than a
 * discovery.
 */
const DAY = 24 * 60 * 60;
const PRIZE = 1_000n;

/** Finds an r where both users clear their own threshold, so both should win. */
function findR(drawId: number, a: string, b: string, total: bigint): bigint {
  const uniform = (entropy: bigint, upper: bigint): bigint => {
    if (upper === 0n) return 0n;
    const MAX = (1n << 256n) - 1n;
    const min = (MAX - upper + 1n) % upper;
    let x = entropy;
    while (x < min) {
      x = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [x])));
    }
    return x % upper;
  };
  const th = (r: bigint, who: string): bigint =>
    uniform(
      BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["uint64", "uint32", "address"], [r, drawId, who]),
        ),
      ),
      total,
    );
  for (let r = 1n; r < 4000n; r++) {
    // Each holds half the weight, so "both win" needs both thresholds below half.
    if (th(r, a) < total / 2n && th(r, b) < total / 2n) return r;
  }
  throw new Error("no r found where both win");
}

async function setup() {
  await fhevm.initializeCLIApi();
  const [deployer, alice, bob] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("ERC7984Mock");
  const token = await Token.deploy("cUSDC", "cUSDC", "");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();

  const Pool = await ethers.getContractFactory("PrizePoolHarness");
  const pool = await Pool.deploy(tokenAddr, 0);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();

  const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
  for (const who of [deployer, alice, bob]) {
    await (await token.mint!(who!.address, 1_000_000n)).wait();
    await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
  }
  await (await pool.setPrize!(PRIZE)).wait();

  // Alice and Bob hold exactly the same amount for exactly the same time.
  for (const who of [alice, bob]) {
    const e = await fhevm.createEncryptedInput(poolAddr, who!.address).add64(10_000n).encrypt();
    await (await pool.connect(who!).deposit!(e.handles[0], e.inputProof)).wait();
  }

  // Exactly ONE prize in the reserve.
  const f = await fhevm.createEncryptedInput(poolAddr, deployer!.address).add64(PRIZE).encrypt();
  await (await pool.connect(deployer!).fundReserve!(f.handles[0], f.inputProof)).wait();

  await ethers.provider.send("evm_increaseTime", [DAY]);
  await ethers.provider.send("evm_mine", []);
  await (await pool.openDraw!()).wait();

  return { deployer, alice, bob, pool, poolAddr };
}

async function won(pool: any, poolAddr: string, who: any): Promise<bigint> {
  const h: string = await pool.winningsOf!(who.address);
  if (h === ethers.ZeroHash) return 0n;
  return (await fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, who)) as bigint;
}

describe("the reserve decides by order, and the keeper picks the order", () => {
  it("pays whoever is accrued FIRST when the reserve holds one prize", async () => {
    const { alice, bob, pool, poolAddr } = await setup();

    // Both hold half the weight; pick randomness where both clear their threshold.
    const total = 2n * 10_000n * BigInt(DAY);
    const r = findR(1, alice!.address, bob!.address, total);
    await (await pool.forceReveal!(1, r, total)).wait();

    // Both really are winners under the public rule.
    expect(await pool.thresholdFor!(1, alice!.address)).to.be.lessThan(total / 2n);
    expect(await pool.thresholdFor!(1, bob!.address)).to.be.lessThan(total / 2n);

    await (await pool.accrueMany!([alice!.address, bob!.address], 1)).wait();

    expect(await won(pool, poolAddr, alice)).to.equal(PRIZE, "first in the array is paid");
    expect(await won(pool, poolAddr, bob)).to.equal(0n, "second gets nothing — the reserve was spent");
  });

  it("pays the OTHER one when the array is reversed — same draw, same randomness", async () => {
    const { alice, bob, pool, poolAddr } = await setup();

    const total = 2n * 10_000n * BigInt(DAY);
    const r = findR(1, alice!.address, bob!.address, total);
    await (await pool.forceReveal!(1, r, total)).wait();

    await (await pool.accrueMany!([bob!.address, alice!.address], 1)).wait();

    expect(await won(pool, poolAddr, bob)).to.equal(PRIZE, "reversing the array reverses the outcome");
    expect(await won(pool, poolAddr, alice)).to.equal(0n);
  });

  it("pays both when the reserve covers both — so it is scarcity, not the rule", async () => {
    const { deployer, alice, bob, pool, poolAddr } = await setup();

    const f = await fhevm.createEncryptedInput(poolAddr, deployer!.address).add64(PRIZE).encrypt();
    await (await pool.connect(deployer!).fundReserve!(f.handles[0], f.inputProof)).wait();

    const total = 2n * 10_000n * BigInt(DAY);
    const r = findR(1, alice!.address, bob!.address, total);
    await (await pool.forceReveal!(1, r, total)).wait();

    await (await pool.accrueMany!([alice!.address, bob!.address], 1)).wait();

    expect(await won(pool, poolAddr, alice)).to.equal(PRIZE);
    expect(await won(pool, poolAddr, bob)).to.equal(PRIZE);
  });
});
