/**
 * The holder's own TWAB record, reconstructed in their browser.
 *
 * Every function here is pure arithmetic over values the holder already has: their
 * decrypted observation array, and the draw fields the chain publishes. Nothing is
 * written, nothing is sent, and no permission is added — `totalWeight` and `k[t]`
 * are public, and the weight is already theirs to read. This is division.
 *
 * TWO BOUNDARIES, and they are load-bearing rather than stylistic:
 *
 *   1. No value produced here may enter a URL, a query parameter, or a
 *      copy-to-clipboard payload. A link a holder can paste is a link that
 *      discloses them, and a "share my odds" button would undo the whole design.
 *   2. No value produced here may leave the browser — no analytics event, no
 *      server call, no logging. These figures exist on screen and nowhere else.
 *
 * `cumulativeAtLocal` is a deliberate mirror of `ConfidentialPrizePool._cumulativeAt`:
 *
 *     if (obs.length == 0 || obs[0].timestamp > target) return 0;
 *     o = obs[_indexAt(obs, target)];
 *     return o.cumulative + o.balance * (target - o.timestamp);
 *
 * Reproducing it here is what lets a per-draw weight be computed without a
 * transaction — `weightFor` is a state change because it must grant ACL on chain,
 * but a holder who has already decrypted their observations needs no grant to do
 * the same sum themselves.
 */

/** One entry of the holder's observation array, decrypted. */
export interface Observation {
  readonly timestamp: number;
  readonly balance: bigint;
  readonly cumulative: bigint;
}

/** The published fields of a draw. */
export interface DrawWindow {
  readonly id: number;
  readonly periodStart: number;
  readonly snapshotAt: number;
  readonly totalWeight: bigint;
  readonly revealed: boolean;
}

/** The index of the last observation at or before `target`, or -1. */
function indexAt(obs: readonly Observation[], target: number): number {
  let lo = 0;
  let hi = obs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid]!.timestamp <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Cumulative balance-seconds at `target`. Mirrors the contract exactly. */
export function cumulativeAtLocal(obs: readonly Observation[], target: number): bigint {
  if (obs.length === 0 || obs[0]!.timestamp > target) return 0n;
  const o = obs[indexAt(obs, target)]!;
  return o.cumulative + o.balance * BigInt(target - o.timestamp);
}

/**
 * The holder's weight for one draw.
 *
 * The contract's `_windowStart` starts from the PREVIOUS draw's snapshot when that
 * draw was revealed, so consecutive windows abut rather than overlap; it falls back
 * to `periodStart` for the first draw and after a cancellation. This mirrors the
 * fallback only — the caller passes the window it wants — which is exact for the
 * common case and stated as approximate where it is not.
 */
export function weightForWindow(obs: readonly Observation[], w: DrawWindow): bigint {
  const end = cumulativeAtLocal(obs, w.snapshotAt);
  const start = cumulativeAtLocal(obs, w.periodStart);
  return end > start ? end - start : 0n;
}

/** Was the holder in this draw at all? Zero weight cannot win, whatever the threshold. */
export function participated(obs: readonly Observation[], w: DrawWindow): boolean {
  return obs.length > 0 && obs[0]!.timestamp <= w.snapshotAt;
}

/**
 * Odds of clearing tier `t`, as a percentage.
 *
 * `P(win tier t) = weight / (totalWeight * k[t])`, the contract's own rule. Returns
 * 0 rather than throwing when the divisor is unavailable, because a screen showing
 * `0%` next to "not computable" would be a lie and the caller checks first.
 */
export function tierOddsPct(weight: bigint, totalWeight: bigint, k: bigint): number {
  if (totalWeight === 0n || k === 0n) return 0;
  return (Number(weight) / (Number(totalWeight) * Number(k))) * 100;
}

/** "about one every N draws" — legible where a percentage is not. */
export function oneEvery(pct: number): string {
  if (pct <= 0) return "never, at this position";
  const n = 100 / pct;
  if (n < 1.5) return "about one every draw";
  if (n < 1000) return `about one every ${Math.round(n).toLocaleString()} draws`;
  return `about one every ${Math.round(n / 100) / 10}k draws`;
}

/**
 * The holder's average balance over a window.
 *
 * The difference between "how much" and "how much, and for how long" in one number:
 * balance-seconds divided by seconds is the balance they held on average, which is
 * what the odds are actually computed from — not the balance showing today.
 */
export function averageBalance(obs: readonly Observation[], from: number, to: number): bigint {
  if (to <= from) return 0n;
  const span = BigInt(to - from);
  const w = cumulativeAtLocal(obs, to) - cumulativeAtLocal(obs, from);
  return w > 0n ? w / span : 0n;
}

/** Points for the weight-accrual chart, one per observation plus `now`. */
export function accrualSeries(
  obs: readonly Observation[],
  now: number,
): { t: number; balance: bigint; cumulative: bigint }[] {
  if (obs.length === 0) return [];
  const pts = obs.map((o) => ({ t: o.timestamp, balance: o.balance, cumulative: o.cumulative }));
  const last = obs[obs.length - 1]!;
  if (now > last.timestamp) {
    pts.push({ t: now, balance: last.balance, cumulative: cumulativeAtLocal(obs, now) });
  }
  return pts;
}
