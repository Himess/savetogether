"use client";

import Link from "next/link";
import { Connect } from "./Connect";
import { VaultProof } from "./VaultProof";

export function VaultPage() {
  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="wordmark">
            Ghost<span>Pool</span>
          </div>
          <div className="masthead-note">Vault integration</div>
          <div className="chain-pill">SEPOLIA</div>
        </div>
      </header>

      <main>
        <p className="lede">
          <strong>Evidence, not a second pool.</strong>{" "}
GhostPool composes with Zama&apos;s
          own confidential vault rather than only with its own yield source. This is the
          round that proves it, read live from the chain.
        </p>

        <Connect />
        <VaultProof />

        <p className="note note--plain" style={{ marginTop: 24 }}>
          <Link href="/" style={{ color: "var(--ink-2)", textDecoration: "underline" }}>
            ← Back to the pool
          </Link>
        </p>
      </main>
    </>
  );
}

export default VaultPage;
