"use client";

import { Balances } from "./Balances";
import { Connect } from "./Connect";
import { Deposit } from "./Deposit";
import { DrawStatus } from "./DrawStatus";
import { Withdraw } from "./Withdraw";
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
      </main>
    </>
  );
}

export default App;
