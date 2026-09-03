import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

/**
 * The draw rule, recomputed in the browser from public inputs alone.
 *
 * This is a port of `ConfidentialPrizePool._uniform` and `thresholdFor`, and it
 * is deliberately a SECOND implementation rather than a call to the contract.
 * Asking the contract what its threshold is and then agreeing with it proves
 * nothing; recomputing it from `r`, the draw id, the address and `totalWeight`
 * and THEN finding that it matches is the whole audit.
 *
 * Every input here is public. That is why `A2` — encrypting `totalWeight` — was
 * measured at 8.3x and rejected: it would have cost exactly this.
 */

/** PoolTogether's `UniformRandomNumber.uniform`, in TypeScript. */
export function uniform(entropy: bigint, upperBound: bigint): { value: bigint; rejections: number } {
  if (upperBound === 0n) return { value: 0n, rejections: 0 };
  const MAX = (1n << 256n) - 1n;
  const min = (MAX - upperBound + 1n) % upperBound;
  let x = entropy;
  let rejections = 0;
  // A bare modulus over-represents [0, min) — for a lottery that is a bias in
  // who wins. Rejection sampling removes it exactly rather than bounding it.
  while (x < min) {
    x = BigInt(keccak256(encodeAbiParameters(parseAbiParameters("uint256"), [x])));
    rejections++;
  }
  return { value: x % upperBound, rejections };
}

/** `uniform(keccak256(r, drawId, user, tier), totalWeight * k[tier])`. */
export function thresholdFor(
  r: bigint,
  drawId: number,
  user: `0x${string}`,
  totalWeight: bigint,
  tier: number,
  k: bigint,
): bigint {
  const entropy = BigInt(
    keccak256(
      encodeAbiParameters(parseAbiParameters("uint64, uint32, address, uint8"), [
        r,
        drawId,
        user,
        tier,
      ]),
    ),
  );
  // The tier widens the RANGE where V5 narrows the zone, so
  // P(win tier t) = weight / (totalWeight * k[t]) and the expected winners of
  // tier t is exactly 1/k[t] — independent of how the balances are distributed.
  return uniform(entropy, totalWeight * k).value;
}

/** The rejection floor, for showing that the sampling is the unbiased one. */
export function rejectionFloor(upperBound: bigint): bigint {
  if (upperBound === 0n) return 0n;
  const MAX = (1n << 256n) - 1n;
  return (MAX - upperBound + 1n) % upperBound;
}

/** Odds as a percentage, for a weight that the viewer is allowed to know. */
export function oddsPct(weight: bigint, totalWeight: bigint, k: bigint): number {
  if (totalWeight === 0n || k === 0n) return 0;
  return (Number(weight) / (Number(totalWeight) * Number(k))) * 100;
}
