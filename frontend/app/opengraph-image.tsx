import { ImageResponse } from "next/og";

/**
 * The card that appears when the link is pasted anywhere.
 *
 * Generated rather than shipped as a PNG: the hook has changed twice already, and
 * a static image is the thing nobody remembers to re-export. This one reads the
 * same words the README opens with, in the same navy the mark is drawn in.
 *
 * The mark is redrawn here in SVG rather than embedded, because `ImageResponse`
 * cannot fetch a local file at build time on every host — and the shape is nine
 * elements: a ticket, two eyes, a smile, three redacted bars.
 */
export const runtime = "nodejs";
export const alt = "SaveTogether — confidential prize savings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const NAVY = "#1B3A5C";
const PAPER = "#FAFAF9";
const INK = "#16191D";
const INK2 = "#565C64";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {/* the ticket */}
          <svg width="86" height="86" viewBox="0 0 1024 1024">
            <path
              d="M100 320a56 56 0 0 1 56-56h712a56 56 0 0 1 56 56v130a62 62 0 0 0 0 124v130a56 56 0 0 1-56 56H156a56 56 0 0 1-56-56V574a62 62 0 0 0 0-124z"
              fill={NAVY}
            />
            <circle cx="258" cy="455" r="42" fill={PAPER} />
            <circle cx="378" cy="455" r="42" fill={PAPER} />
            <path
              d="M238 560a112 112 0 0 0 200 0"
              stroke={PAPER}
              strokeWidth="34"
              strokeLinecap="round"
              fill="none"
            />
            <rect x="516" y="398" width="320" height="52" rx="26" fill="#93A3B5" />
            <rect x="516" y="486" width="222" height="52" rx="26" fill="#63768A" />
            <rect x="516" y="574" width="278" height="52" rx="26" fill="#8496AA" />
          </svg>
          <div style={{ display: "flex", fontSize: 42, fontWeight: 800, color: INK, letterSpacing: -1 }}>
            SaveTogether
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 60, lineHeight: 1.12, fontWeight: 800, color: INK, letterSpacing: -1.8, maxWidth: 1000 }}>
            Zama shipped confidential yield. We turned that yield into a prize —
          </div>
          <div style={{ display: "flex", fontSize: 60, lineHeight: 1.12, fontWeight: 800, color: NAVY, letterSpacing: -1.8 }}>
            and hid the winner and the odds.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", fontSize: 26, color: INK2 }}>
            Your balance, your odds and your result stay encrypted
          </div>
          <div style={{ display: "flex", fontSize: 24, color: INK2 }}>Sepolia · FHEVM</div>
        </div>
      </div>
    ),
    size,
  );
}
