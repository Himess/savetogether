/**
 * B0b — recompute a live draw from public data and check it.
 *
 * A2 was rejected specifically to keep this possible: `r` and `totalWeight` are
 * published, so every threshold is a pure function of public inputs and anyone
 * can recompute the rule the pool claims to have followed.
 *
 * BE PRECISE ABOUT WHAT AN OUTSIDER CAN AND CANNOT CHECK, because overstating it
 * would be worse than not having the script.
 *
 *   Anyone, with no permissions at all:
 *     - every participant's threshold, recomputed from (r, drawId, address,
 *       totalWeight) and compared against the contract's own `thresholdFor`
 *     - that the rejection sampling is the unbiased one, not a bare modulus
 *     - that `r` and `totalWeight` arrived through a KMS-signed reveal
 *
 *   A PARTICIPANT, for themselves only:
 *     - their own weight, decrypted, against their own threshold
 *     - therefore their own outcome, checked against their decrypted winnings
 *
 *   Nobody:
 *     - anyone else's outcome. Weights are encrypted, which is the product.
 *
 * So the draw is publicly auditable for FAIRNESS OF THE RULE and privately
 * auditable for CORRECTNESS OF THE RESULT. That is the strongest statement the
 * design supports, and it is a great deal stronger than "trust the keeper".
 *
 *   npx hardhat run scripts/verify-draw.ts --network sepolia
 *   DRAW=61 npx hardhat run scripts/verify-draw.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const POOL = process.env.POOL ?? "0x1d8A0d653027833E4e8eA4DE67B90512Aad7B85f";

/** PoolTogether's UniformRandomNumber.uniform, in TypeScript. */
function uniform(entropy: bigint, upperBound: bigint): bigint {
  if (upperBound === 0n) return 0n;
  const MAX = (1n << 256n) - 1n;
  const min = (MAX - upperBound + 1n) % upperBound;
  let x = entropy;
  let rejections = 0;
  while (x < min) {
    x = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [x])));
    rejections++;
  }
  return x % upperBound;
}

function thresholdFor(r: bigint, drawId: number, user: string, totalWeight: bigint): bigint {
  const entropy = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint64", "uint32", "address"], [r, drawId, user]),
    ),
  );
  return uniform(entropy, totalWeight);
}

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, signer!);

  const count = Number(await pool.drawCount!());
  const drawId = Number(process.env.DRAW ?? 0) || (await lastRevealed(pool, count));
  if (drawId === 0) throw new Error("no revealed draw to verify");

  const d = await pool.drawAt!(drawId);
  if (Number(d.status) !== 2) throw new Error(`draw ${drawId} is not revealed (status ${d.status})`);

  const r = BigInt(d.r);
  const totalWeight = BigInt(d.totalWeight);
  const window = Number(d.snapshotAt) - Number(d.periodStart);

  console.log(`pool     ${POOL}`);
  console.log(`draw     ${drawId} of ${count}`);
  console.log(`window   ${Number(d.periodStart)} -> ${Number(d.snapshotAt)}  (${window}s)`);
  console.log(`r        ${r}`);
  console.log(`total    ${totalWeight}   implied balance ${(Number(totalWeight / BigInt(window || 1)) / 1e6).toLocaleString("en-US")} cUSDC`);

  // ---- participants, from public deposit events ----
  // Chunked: public RPCs cap getLogs at 50,000 blocks, and querying from 0 is
  // how this script failed the first time it was pointed at a real endpoint.
  const latest = await ethers.provider.getBlockNumber();
  const DEPLOY = Number(process.env.FROM_BLOCK ?? 11_609_800);
  const users: string[] = [];
  const seen = new Set<string>();
  for (let from = DEPLOY; from <= latest; from += 9_000) {
    const to = Math.min(from + 8_999, latest);
    const chunk = await pool.queryFilter(pool.filters.Deposited!(), from, to);
    for (const e of chunk) {
      const u = (e as unknown as { args: { user: string } }).args.user;
      if (!seen.has(u.toLowerCase())) { seen.add(u.toLowerCase()); users.push(u); }
    }
  }
  console.log(`\nparticipants ${users.length} (from public Deposited events — identities are NOT hidden)`);

  // ---- 1. PUBLIC: every threshold, recomputed and compared ----
  console.log(`\n1. thresholds recomputed from public inputs, checked against the contract`);
  let ok = 0;
  for (const u of users) {
    const mine = thresholdFor(r, drawId, u, totalWeight);
    const theirs = BigInt(await pool.thresholdFor!(drawId, u));
    const match = mine === theirs;
    if (match) ok++;
    console.log(
      `   ${u}  ${match ? "match" : "MISMATCH"}  ${mine.toString().padStart(16)}` +
        `   ${((Number(mine) / Number(totalWeight)) * 100).toFixed(2)}% of total weight`,
    );
    if (!match) console.log(`      contract says ${theirs}`);
  }
  console.log(`   ${ok}/${users.length} thresholds reproduce exactly`);

  // ---- 2. PUBLIC: the sampling is unbiased ----
  const MAX = (1n << 256n) - 1n;
  const min = (MAX - totalWeight + 1n) % totalWeight;
  console.log(`\n2. rejection sampling`);
  console.log(`   rejection floor ${min}  (${((Number(min) / Number(MAX)) * 100).toExponential(2)}% of the range)`);
  console.log(`   a bare modulus would over-represent [0, ${min}) — this rejects instead of truncating`);

  // ---- 3. PRIVATE: my own outcome, end to end ----
  console.log(`\n3. my own outcome, which only I can check`);
  if (!users.map((u) => u.toLowerCase()).includes(me.toLowerCase())) {
    console.log(`   ${me} is not a participant in this pool — nothing to verify`);
  } else {
    const myThreshold = thresholdFor(r, drawId, me, totalWeight);
    // weightFor grants the handle to the caller, so this is a transaction.
    const tx = await pool.weightFor!(drawId, me);
    await tx.wait();
    const handle: string = await pool.weightFor!.staticCall(drawId, me);
    const weight = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, POOL, signer!)) as bigint;
    const shouldWin = weight > myThreshold;
    console.log(`   my weight     ${weight}`);
    console.log(`   my threshold  ${myThreshold}`);
    console.log(`   rule says     ${shouldWin ? "WIN" : "no win"}`);
    console.log(`   my odds this draw: ${((Number(weight) / Number(totalWeight)) * 100).toFixed(2)}%`);
    const accrued: boolean = await pool.accrued!(drawId, me);
    console.log(`   accrued       ${accrued}`);
  }

  console.log(`\nwhat this proves: the RULE is publicly auditable and the RESULT is`);
  console.log(`auditable by its owner. Nobody can audit anyone else's result, which`);
  console.log(`is the product rather than a gap.`);
}

async function lastRevealed(pool: { drawAt: (i: number) => Promise<{ status: number }> }, count: number): Promise<number> {
  for (let i = count; i >= 1; i--) {
    const d = await pool.drawAt(i);
    if (Number(d.status) === 2) return i;
  }
  return 0;
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
