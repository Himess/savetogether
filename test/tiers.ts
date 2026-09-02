/**
 * Tier helpers for tests that predate tiers.
 *
 * Most of this suite was written against a single flat prize and asserts
 * `winnings == PRIZE`. Those assertions are still the right ones — the tier
 * machinery must not change what a lone ordinary winner receives — so rather
 * than rewriting them, this configures a tier shape where the rare tiers cannot
 * realistically fire.
 *
 * `P(win tier t) = weight / (totalWeight * k[t])`, so `k = 1e12` makes tier 0 a
 * one-in-a-trillion event per participant per draw. It is not literally
 * impossible, which is worth stating rather than pretending: it is far below the
 * probability of any other flake in a test run, and the alternative — allowing
 * `setTiers` to accept equal `k` so a genuinely flat shape exists — would remove
 * the guard that stops the tier order being inverted by a typo.
 *
 * Tests that exercise tiers on purpose use `tieredPrizes` instead.
 */

/** k for a shape that behaves as one flat prize. */
export const FLAT_K: [bigint, bigint, bigint] = [10n ** 12n, 10n ** 6n, 1n];

/** Prizes whose ordinary tier is `p`. Strictly decreasing, as `setTiers` requires. */
export function flatPrizes(p: bigint): [bigint, bigint, bigint] {
  return [p * 3n, p * 2n, p];
}

/** The derived production shape: grand every 100 draws, middle every 10, ordinary every draw. */
export const LIVE_K: [bigint, bigint, bigint] = [100n, 10n, 1n];
export function livePrizes(unit: bigint): [bigint, bigint, bigint] {
  return [unit * 25n, unit * 5n, unit];
}

/**
 * Sets a shape that behaves exactly like the old single prize.
 *
 * Every tier pays the same amount with the same odds, so whichever fires the
 * winner receives `p` — which is what the pre-tier assertions check. It goes
 * through the harness because `setTiers` refuses equal prizes on purpose.
 *
 * Falls back to `setTiers` with a descending shape when the contract is not a
 * harness, which is only the on-chain tests.
 */
export async function setFlatPrize(pool: any, p: bigint): Promise<void> {
  if (typeof pool.forceTiers === "function") {
    await (await pool.forceTiers([p, p, p], [1n, 1n, 1n])).wait();
    return;
  }
  await (await pool.setTiers(flatPrizes(p), FLAT_K)).wait();
}
