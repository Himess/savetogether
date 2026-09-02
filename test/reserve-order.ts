import { expect } from "chai";
import { setFlatPrize } from "./tiers";
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

/** Carried between the two ordering tests, which is the whole comparison. */
let forwardWinner = "";

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
  // The tier is part of the hash now, and FLAT_K puts the reachable tier at 2
  // with k = 1, so the range is totalWeight exactly as before.
  const th = (r: bigint, who: string): bigint =>
    uniform(
      BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint64", "uint32", "address", "uint8"],
            [r, drawId, who, 2],
          ),
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
  await setFlatPrize(pool, PRIZE);

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

describe("B1 — the reserve still decides, but the keeper no longer picks", () => {
  it("pays the SAME winner whichever order the array is in", async () => {
    const { alice, bob, pool, poolAddr } = await setup();

    // Both hold half the weight; pick randomness where both clear their threshold.
    const total = 2n * 10_000n * BigInt(DAY);
    const r = findR(1, alice!.address, bob!.address, total);
    await (await pool.forceReveal!(1, r, total)).wait();

    // Both really are winners under the public rule.
    expect(await pool["thresholdFor(uint32,address,uint8)"]!(1, alice!.address, 2)).to.be.lessThan(total / 2n);
    expect(await pool["thresholdFor(uint32,address,uint8)"]!(1, bob!.address, 2)).to.be.lessThan(total / 2n);

    await (await pool.accrueMany!([alice!.address, bob!.address], 1)).wait();

    // One of them is paid and the other is not — the reserve holds one prize.
    // WHICH one is now a function of keccak256(drawId, user) and nothing else.
    const a1 = await won(pool, poolAddr, alice);
    const b1 = await won(pool, poolAddr, bob);
    expect(a1 + b1).to.equal(PRIZE, "exactly one prize is paid");
    forwardWinner = a1 === PRIZE ? "alice" : "bob";
  });

  it("reversing the array does NOT reverse the outcome — this is the fix", async () => {
    const { alice, bob, pool, poolAddr } = await setup();

    const total = 2n * 10_000n * BigInt(DAY);
    const r = findR(1, alice!.address, bob!.address, total);
    await (await pool.forceReveal!(1, r, total)).wait();

    await (await pool.accrueMany!([bob!.address, alice!.address], 1)).wait();

    const a2 = await won(pool, poolAddr, alice);
    const b2 = await won(pool, poolAddr, bob);
    expect(a2 + b2).to.equal(PRIZE, "still exactly one prize");
    const reverseWinner = a2 === PRIZE ? "alice" : "bob";
    expect(reverseWinner).to.equal(
      forwardWinner,
      "the same address wins whichever way the keeper passes the array",
    );
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
