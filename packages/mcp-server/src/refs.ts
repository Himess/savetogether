/**
 * Reference ids: one place that mints them and one place that recognises them.
 *
 * They were in two places and the two disagreed. The minter emitted
 * `bal_${Math.random().toString(36).slice(2, 10)}` — `bal_haauwfru` — and the
 * resolver accepted `/^[a-z]+_[0-9]+$/`. Everything else said `bal_1`: the tool
 * descriptions, the schema hints, the error message the resolver itself printed,
 * `pool_position`'s reply, and the README. So `pool_deposit` refused the output of
 * `balance`, and the documented reference path into the pool — the flagship flow —
 * was dead for every caller doing it the intended way. `pool_withdraw` shared the
 * defect, which is worse: that is the path OUT.
 *
 * A live session hit it, refused all three workarounds, and said why. It is fixed
 * here rather than at either call site, because a format agreed in two files is a
 * format that can disagree again.
 *
 * WHY THE RECOGNISER IS DELIBERATELY LOOSE. An opaque identifier has no syntax
 * worth validating. `isRefId` checks STRUCTURE — a prefix, an underscore, a
 * suffix — and nothing about what the suffix contains, so it accepts anything a
 * minter can produce, including the random shape this replaced. Whether a
 * reference EXISTS is a question about the session, and the session is the only
 * thing that can answer it. Structure first because a typo must be diagnosable
 * before a session is open; membership second because that is the real question.
 */

/** Every prefix the minter uses. Kept here so the round trip is testable. */
export const REF_PREFIXES = ["bal", "rem", "sent", "dep", "pool", "won", "pend"] as const;

/** `bal_1`, `pool_2` — the shape every description, error and document states. */
export function refId(kind: string, n: number): string {
  return `${kind}_${n}`;
}

/**
 * Structure only. True for anything `refId` can produce, and for the historical
 * base-36 form, so a minter change cannot break the resolver again.
 */
export function isRefId(id: string): boolean {
  return /^[a-z]+_[A-Za-z0-9]+$/.test(id);
}

/** A plain decimal figure, which is the other thing an amount may be. */
export function isFigure(s: string): boolean {
  return /^[0-9]+(\.[0-9]+)?$/.test(s);
}
