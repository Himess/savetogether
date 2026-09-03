/**
 * AB1 — an encrypted value must never be drawn as a number the page cannot know.
 *
 * The defect this pins was on every screen at once: with no wallet connected the
 * PUBLIC balances correctly showed `—` while the ENCRYPTED ones showed `0`. It
 * reads as either "the encryption is decorative" or "this account is empty", and
 * both of those are the opposite of what the product claims. `showConfidential`
 * exists to be the single place that decides, which only helps if the decision
 * is held still — so it is held still here.
 *
 * The interesting case is the third: a REAL zero is a legitimate `0`, because no
 * handle exists at all and that fact is public. Refusing to draw it would be
 * over-correction, and would make an empty account look like a hidden one.
 */
import { expect } from "chai";
import {
  DOTS,
  UNKNOWN,
  ZERO_HANDLE,
  showConfidential,
  showPublic,
} from "../frontend/lib/format";

const HANDLE = "0xd44e5c6b9751e3bc3d74ae59cbf785c6743d372e1aff0000000000aa36a70500";

describe("AB1 — how a confidential value is allowed to appear", () => {
  it("shows nothing knowable when no wallet is connected", () => {
    expect(showConfidential({ connected: false })).to.equal(UNKNOWN);
    // Even with a handle and a decrypted value in hand: not connected is not a
    // state in which this page speaks about anybody's balance.
    expect(
      showConfidential({ connected: false, handle: HANDLE, permitted: true, clear: 5_000_000n }),
    ).to.equal(UNKNOWN);
  });

  it("shows a real zero as 0, because the absence of a handle is public", () => {
    expect(showConfidential({ connected: true, handle: ZERO_HANDLE })).to.equal("0");
    // And it stays 0 whatever else is set: there is no ciphertext to be coy about.
    expect(
      showConfidential({ connected: true, handle: ZERO_HANDLE, permitted: false }),
    ).to.equal("0");
  });

  it("NEVER shows 0 for a handle it has not decrypted", () => {
    // The whole defect, in three lines. Each of these once rendered "0".
    expect(showConfidential({ connected: true, handle: HANDLE })).to.equal(DOTS);
    expect(showConfidential({ connected: true, handle: HANDLE, permitted: false })).to.equal(DOTS);
    expect(
      showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: undefined }),
    ).to.equal(DOTS);
  });

  it("distinguishes in flight from unreadable", () => {
    expect(showConfidential({ connected: true, handle: undefined })).to.equal("…");
    expect(
      showConfidential({ connected: true, handle: HANDLE, permitted: true, fetching: true }),
    ).to.equal("…");
  });

  it("renders the number once it actually has one", () => {
    expect(
      showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: 3_000_000n }),
    ).to.equal("3");
    expect(
      showConfidential({ connected: true, handle: HANDLE, permitted: true, clear: 1_234_500n }),
    ).to.equal("1.2345");
    // decimals 0 renders the raw integer — draw ids and weights, not money.
    expect(
      showConfidential({
        connected: true, handle: HANDLE, permitted: true, clear: 137_001n, decimals: 0,
      }),
    ).to.equal("137001");
  });

  it("keeps the public path in step, so the two cannot drift", () => {
    expect(showPublic(false, 5_000_000n)).to.equal(UNKNOWN);
    expect(showPublic(true, undefined)).to.equal("…");
    expect(showPublic(true, 0n)).to.equal("0");
    expect(showPublic(true, 2_500_000n)).to.equal("2.5");
  });

  it("never returns an empty string, for any input in the state space", () => {
    // A blank cell is the failure mode a reader cannot even name. Enumerate.
    for (const connected of [true, false]) {
      for (const handle of [undefined, null, ZERO_HANDLE, HANDLE]) {
        for (const permitted of [undefined, true, false]) {
          for (const fetching of [undefined, true, false]) {
            for (const clear of [undefined, null, 0n, 42n]) {
              const out = showConfidential({ connected, handle, permitted, fetching, clear });
              expect(out, JSON.stringify({ connected, handle, permitted, fetching, clear: String(clear) }))
                .to.be.a("string").with.length.greaterThan(0);
            }
          }
        }
      }
    }
  });
});
