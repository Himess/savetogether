/**
 * M1 — the five display states of a confidential value.
 *
 * A screen rendering an undecrypted ciphertext as `0` asserts a number the page
 * cannot know, and it makes an empty account indistinguishable from a hidden one.
 * That distinction *is* the product, so it is the one thing on the frontend worth
 * a test of its own.
 *
 * `showConfidential` had none. It was written for AB1, both Pool call sites use
 * it, and nothing anywhere proved it returns what its own doc comment claims. The
 * report that the Pool screen "shows 0 again" could not be answered by reading the
 * code, because reading the code is what produced the bug the first time.
 *
 * Imported directly from the frontend — `format.ts` has no imports at all, which
 * is deliberate and is what makes it testable from here.
 */
import { expect } from "chai";
import {
  DOTS,
  UNKNOWN,
  ZERO_HANDLE,
  showConfidential,
  showPublic,
} from "../frontend/lib/format";

const HANDLE = "0x04f8c697acf55d6a27ac2b6e5ded91fbe3117dde26ff0000000000aa36a70500";

describe("M1 — how a confidential value is allowed to appear", () => {
  it("no wallet — an em dash, never a number", () => {
    expect(showConfidential({ connected: false })).to.equal(UNKNOWN);
    expect(showConfidential({ connected: false, handle: HANDLE })).to.equal(UNKNOWN);
    // Even a decrypted value must not render without a wallet: the page has no
    // business claiming a figure belongs to a session that does not exist.
    expect(showConfidential({ connected: false, handle: HANDLE, permitted: true, clear: 5_000_000n })).to.equal(UNKNOWN);
  });

  it("read in flight — an ellipsis, never a zero", () => {
    expect(showConfidential({ connected: true, handle: undefined })).to.equal("…");
    expect(showConfidential({ connected: true, handle: null })).to.equal("…");
  });

  it("connected but not decrypted — dots, and this is the case that must never be 0", () => {
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: false })).to.equal(DOTS);
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: undefined })).to.equal(DOTS);
    // Permitted, decryption still running.
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, fetching: true })).to.equal("…");
    // Permitted, finished, but this browser got nothing back.
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, fetching: false })).to.equal(DOTS);
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: null })).to.equal(DOTS);
  });

  it("a genuinely real zero renders 0, and only when the handle itself is empty", () => {
    // No handle exists, so nothing was ever deposited. That fact is public and
    // needs no permit — which is why this branch sits ABOVE the permit check.
    expect(showConfidential({ connected: true, handle: ZERO_HANDLE })).to.equal("0");
    expect(showConfidential({ connected: true, handle: ZERO_HANDLE, permitted: false })).to.equal("0");
  });

  it("decrypted — the figure", () => {
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: 12_291_000_000n })).to.equal("12,291");
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: 1_500_000n })).to.equal("1.5");
    // A decrypted zero is a number the page legitimately knows.
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: 0n })).to.equal("0");
  });

  /**
   * The regression this file exists to prevent.
   *
   * An empty account and a hidden one must not render alike. If this ever fails,
   * the Pool screen is telling a visitor that someone holds nothing when in fact
   * it simply cannot see.
   */
  it("an empty account and a hidden account never render the same", () => {
    const empty = showConfidential({ connected: true, handle: ZERO_HANDLE, permitted: false });
    const hidden = showConfidential({ connected: true, handle: HANDLE, permitted: false });
    expect(empty).to.equal("0");
    expect(hidden).to.equal(DOTS);
    expect(empty).to.not.equal(hidden);
  });

  it("showPublic keeps the same shape so the two never drift", () => {
    expect(showPublic(false, 5n)).to.equal(UNKNOWN);
    expect(showPublic(true, undefined)).to.equal("…");
    expect(showPublic(true, 2_500_000n)).to.equal("2.5");
    expect(showPublic(true, 42n, 0)).to.equal("42");
  });
});
