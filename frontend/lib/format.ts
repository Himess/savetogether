// Formatting helpers shared across screens.

export const DOTS = "••••••";
export const UNKNOWN = "—";
export const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * How a confidential value is allowed to appear on screen.
 *
 * This exists because every screen wrote its own version of it and every one of
 * them rendered `0` for a value it did not have. With no wallet connected the
 * public balances correctly showed `—` while the ENCRYPTED ones showed `0`,
 * which is exactly backwards: an undecrypted ciphertext displayed as zero
 * asserts a number the page cannot know, and a reader takes it as either "the
 * encryption is not real" or "this account is empty".
 *
 * There are five states and only one of them is a number:
 *
 *   no wallet          `—`      nothing is knowable, public or confidential
 *   loading            `…`
 *   uninitialised      `0`      a REAL zero: no handle exists because nothing
 *                               was ever deposited, and that is public
 *   not decrypted      `•••`    a value exists and this browser cannot read it
 *   decrypted          the number
 *
 * The distinction between the third and fourth is the product. Keeping it in one
 * function is the only way it stays true on every screen.
 */
export interface Confidential {
  /** Is a wallet connected at all? */
  readonly connected: boolean;
  /** The ciphertext handle, or undefined while the read is in flight. */
  readonly handle?: unknown;
  /** Has the user signed the EIP-712 decrypt permit for this contract? */
  readonly permitted?: boolean;
  /** Is the decryption request in flight? */
  readonly fetching?: boolean;
  /** The decrypted value, once there is one. */
  readonly clear?: unknown;
  /** Token decimals. 6 for cUSDC; 0 renders the raw integer. */
  readonly decimals?: number;
}

export function showConfidential(v: Confidential): string {
  if (!v.connected) return UNKNOWN;
  if (v.handle === undefined || v.handle === null) return "…";
  if (v.handle === ZERO_HANDLE) return "0";
  if (v.permitted !== true) return DOTS;
  if (v.fetching === true) return "…";
  if (v.clear === undefined || v.clear === null) return DOTS;
  const raw = BigInt(v.clear as string | number | bigint);
  return (v.decimals ?? 6) === 0 ? raw.toString() : fmtUnits6(raw);
}

/** The same five states for a PUBLIC value, so the two never drift apart. */
export function showPublic(connected: boolean, value: unknown, decimals = 6): string {
  if (!connected) return UNKNOWN;
  if (value === undefined || value === null) return "…";
  const raw = BigInt(value as string | number | bigint);
  return decimals === 0 ? raw.toString() : fmtUnits6(raw);
}

// 6-dec confidential amounts (euint64 base units) → human string.
export function fmtUnits6(v: bigint | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v == null) return "—";
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  if (opts.compact) return compact(Number(v) / 1e6);
  const s = whole.toLocaleString("en-US");
  if (frac === 0n) return s;
  const f = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${s}.${f}`;
}

// compact 2.41M / 320 style used across the dashboard + markets.
export function compact(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "K";
  return Math.round(n).toLocaleString("en-US");
}

export function shortAddr(a?: string): string {
  if (!a) return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

// mm:ss countdown from a seconds value.
export function mmss(sec: number): string {
  if (sec <= 0 || !isFinite(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function pct(n: number, digits = 1): string {
  if (!isFinite(n)) return "0%";
  return n.toFixed(digits) + "%";
}
