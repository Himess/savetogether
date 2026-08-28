"use client";

import { Balances } from "./Balances";
import { Connect } from "./Connect";
import { Deposit } from "./Deposit";
import { DrawStatus } from "./DrawStatus";
import { Withdraw } from "./Withdraw";
import { POOL } from "../lib/addresses";

export function App() {
  return (
    <main>
      <h1>GhostPool</h1>
      <p className="sub">
        No-loss prize savings. Your deposit is never at risk; the yield funds a prize,
        and your balance, your odds and whether you won all stay encrypted.
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
  );
}

export default App;
