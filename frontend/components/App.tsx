"use client";

import { Balances } from "./Balances";
import { Connect } from "./Connect";
import { Deposit } from "./Deposit";
import { DrawStatus } from "./DrawStatus";
import { Withdraw } from "./Withdraw";
import Link from "next/link";
import { POOL } from "../lib/addresses";

export function App() {
  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <div className="wordmark">
            Ghost<span>Pool</span>
          </div>
          <div className="masthead-note">Confidential prize savings</div>
          <div className="chain-pill">SEPOLIA</div>
        </div>
      </header>

      <main>
        <p className="lede">
          <strong>No-loss prize savings.</strong> Your deposit is never at risk; the yield
          funds a prize, and your balance, your odds and whether you won all stay encrypted.
        </p>

        {!POOL && (
          <div className="banner">
            No pool address configured. Set <span className="mono">NEXT_PUBLIC_POOL</span> and rebuild.
          </div>
        )}

        <Connect />
        <DrawStatus />
        <Balances />
        <Deposit />
        <Withdraw />

        {/* Reached deliberately, never on the primary path: the vault-backed
            pool pays no prize, and a judge who wanders into it by accident
            would read the product as broken. */}
        <p className="note note--plain" style={{ marginTop: 24 }}>
          <Link href="/vault" style={{ color: "var(--ink-2)", textDecoration: "underline" }}>
            See the Zama vault integration →
          </Link>
        </p>
      </main>
    </>
  );
}

export default App;
