/**
 * G1 — `can_afford` is a budget oracle, and its description said it was not.
 *
 * The description read: "Yes or no. Leaks neither the budget nor anything else —
 * prefer this over revealing a number when the user only needs to know whether
 * something fits."
 *
 * That is true of one call and false of a sequence. `canAfford` is a clean
 * monotone predicate `left >= amount` over an encrypted value, with no counter,
 * no cooldown and no log, so binary search recovers the budget exactly. This
 * file measures how many calls that actually takes, then pins the mitigation.
 *
 * The predicate under test is the real one from `SessionClient.canAfford`:
 *
 *     const left = await userDecrypt(...);
 *     return left >= amount;
 *
 * reproduced here in the clear because the leak is in the SHAPE of the answer,
 * not in the cryptography — the ciphertext is never the thing that gives way.
 */
import { expect } from "chai";
import { coarsenBudget, COARSE_BUCKET } from "../packages/mcp-server/src/sanitize";

/** The exact predicate `can_afford` exposes today. */
const exactOracle = (budget: bigint) => (amount: bigint) => budget >= amount;

/** Binary search for the largest amount the oracle still says yes to. */
function search(oracle: (a: bigint) => boolean, hi: bigint): { found: bigint; calls: number } {
  let lo = 0n;
  let calls = 0;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high + 1n) / 2n;
    calls++;
    if (oracle(mid)) lo = mid;
    else high = mid - 1n;
  }
  return { found: lo, calls };
}

describe("G1 — can_afford as an oracle", () => {
  const U = 1_000_000n; // 6 decimals

  it("recovers a budget exactly, and the call count is small", () => {
    // A realistic session budget, and an attacker who only assumes "at most a
    // million tokens" rather than the full uint64 range.
    const budget = 4_237_512_345n; // 4,237.512345 cUSDC — deliberately not round
    const hi = 1_000_000n * U; // 1e12

    const { found, calls } = search(exactOracle(budget), hi);

    expect(found).to.equal(budget);
    expect(calls).to.be.lessThan(45);
    console.log(`      exact budget recovered: ${found} (${Number(found) / 1e6} cUSDC) in ${calls} calls`);
  });

  it("needs at most 64 calls even over the whole uint64 range", () => {
    const budget = 18_446_744_073_709_551_000n; // near uint64 max
    const { found, calls } = search(exactOracle(budget), 2n ** 64n - 1n);
    expect(found).to.equal(budget);
    expect(calls).to.be.at.most(64);
    console.log(`      full uint64 range: ${calls} calls`);
  });

  it("the hosted rate limit does not stop it — the attack fits in one window", () => {
    const RATE_LIMIT = 60; // packages/hosted/src/server.ts:46
    const budget = 4_237_512_345n;
    const { calls } = search(exactOracle(budget), 1_000_000n * U);
    expect(calls).to.be.lessThan(RATE_LIMIT);
    console.log(`      ${calls} calls vs a 60/minute limit — one window, no throttling felt`);
  });

  // -------------------------------------------------------------- mitigation
  describe("coarsened answers remove the signal rather than slowing it", () => {
    /** The shipped predicate: compare against the budget rounded DOWN to a bucket. */
    const coarseOracle = (budget: bigint) => (amount: bigint) => coarsenBudget(budget) >= amount;

    it("never over-promises: a coarse yes is always a real yes", () => {
      // Rounding DOWN is the safe direction — it can refuse something affordable,
      // but it can never approve something that would fail on chain.
      for (let i = 0n; i < 400n; i++) {
        const budget = 1_000_000n + i * 7_919n; // arbitrary, non-aligned
        const coarse = coarsenBudget(budget);
        expect(coarse).to.be.at.most(budget);
        for (const probe of [coarse, coarse / 2n, 1n]) {
          if (probe > 0n && coarseOracle(budget)(probe)) {
            expect(budget >= probe, `coarse yes must imply real yes`).to.equal(true);
          }
        }
      }
    });

    it("collapses the search to the bucket, not to the exact figure", () => {
      const budget = 4_237_512_345n;
      const { found, calls } = search(coarseOracle(budget), 1_000_000n * U);

      // The search still terminates — it just lands on the bucket floor.
      expect(found).to.equal(coarsenBudget(budget));
      expect(found).to.not.equal(budget);

      const residual = budget - found;
      console.log(
        `      recovered ${found} instead of ${budget} — ` +
          `${Number(residual) / 1e6} cUSDC still hidden, bucket ${Number(COARSE_BUCKET) / 1e6} cUSDC, ${calls} calls`,
      );
      expect(residual).to.be.greaterThan(0n);
      expect(residual).to.be.lessThan(COARSE_BUCKET);
    });

    it("every budget inside one bucket is indistinguishable", () => {
      // The property that matters: the oracle cannot separate two budgets that
      // share a bucket, however many times it is asked.
      const a = 4_200_000_000n;
      const b = a + COARSE_BUCKET - 1n;
      expect(coarsenBudget(a)).to.equal(coarsenBudget(b));

      const probes = [1n, 100n * U, 4_000n * U, 4_200n * U, 4_249n * U, 10_000n * U];
      for (const p of probes) {
        expect(coarseOracle(a)(p), `budget ${a} vs ${b} at probe ${p}`).to.equal(coarseOracle(b)(p));
      }
      console.log(`      budgets ${a} and ${b} answer identically to every probe`);
    });

    it("a budget below one bucket discloses only that it is below one bucket", () => {
      const small = COARSE_BUCKET - 1n;
      expect(coarsenBudget(small)).to.equal(0n);
      expect(coarseOracle(small)(1n)).to.equal(false);
      console.log(`      a sub-bucket budget answers "no" to everything — it discloses no figure`);
    });
  });
});
