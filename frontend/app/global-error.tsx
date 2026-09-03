"use client";

/**
 * The last-resort error boundary.
 *
 * It exists partly because every app should have one and partly because Next
 * 16.3's own default `/_global-error` page fails to prerender in this
 * configuration; supplying our own replaces it. A judge who hits an unhandled
 * error should still see something that names the chain and offers a way back,
 * rather than a blank document.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "var(--panel)",
          color: "#e8eaed",
          font: '15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <main style={{ maxWidth: 560, margin: "0 auto", padding: "80px 20px" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something broke</h1>
          <p style={{ color: "#8b919c", margin: "0 0 24px" }}>
            SaveTogether runs on Sepolia. If your wallet is on another network, switching it
            and reloading usually fixes this.
          </p>
          <button
            onClick={reset}
            style={{
              background: "#7dd3a0",
              color: "var(--panel)",
              border: 0,
              borderRadius: 7,
              padding: "9px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
