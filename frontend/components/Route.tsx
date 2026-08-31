"use client";

import { CUSDC, POOL, TOKEN, USDC, VAULT_SHARE } from "../lib/addresses";

/**
 * Where the money is, and what each stop actually pays.
 *
 * The page used to be four panels with no relationship between them, so nobody
 * could tell what the product was for. It is one route: public money becomes
 * confidential money, confidential money earns, earnings become a prize. Saying
 * that once, at the top, is worth more than any individual panel.
 *
 * THE RATES ARE THE HONEST PART AND THEY COST US SOMETHING. Zama's Sepolia
 * "Confidential steakcUSDC" is a mock — it holds shares and pays nothing, which
 * was measured rather than assumed — so its rate is 0 and it is described as a
 * composability proof, because that is what it is. The pool's own source runs at
 * a deliberately theatrical rate so that a three-minute recording shows yield
 * moving at all, and it says so on its own line. A number here that flattered
 * either of them would be the one lie that discredits every honest thing on the
 * rest of the page.
 */

interface Stop {
  readonly name: string;
  readonly what: string;
  readonly rate: string;
  readonly rateNote: string;
  readonly address: string;
  readonly privacy: "public" | "confidential";
}

const STOPS: readonly Stop[] = [
  {
    name: "USDC",
    what: "Ordinary ERC-20. The balance is readable by anyone.",
    rate: "—",
    rateNote: "idle",
    address: USDC,
    privacy: "public",
  },
  {
    name: "cUSDC",
    what: "Zama's confidential wrapper. One for one, and from here the amount is encrypted.",
    rate: "—",
    rateNote: "idle — wrapping earns nothing by itself",
    address: CUSDC,
    privacy: "confidential",
  },
  {
    name: "Zama vault",
    what: "GhostPool's adapter on Zama's confidential vault. Real shares, proved on chain.",
    rate: "0%",
    rateNote: "the Sepolia vault is a mock and pays nothing — this is a composability proof",
    address: VAULT_SHARE,
    privacy: "confidential",
  },
  {
    name: "GhostPool",
    what: "Your principal, never at risk. Only the yield it earns becomes a prize.",
    rate: "1000%",
    rateNote: "a demo rate, on purpose, so a short recording shows yield actually moving",
    address: POOL,
    privacy: "confidential",
  },
];

export function Route({ demoToken = true }: { demoToken?: boolean }) {
  return (
    <div className="panel">
      <h2>Where your money goes</h2>

      <table className="kv route">
        <tbody>
          {STOPS.map((s, i) => (
            <tr key={s.name}>
              <td style={{ width: 34, color: "var(--ink-3)" }}>{i + 1}</td>
              <td>
                <div>
                  <strong>{s.name}</strong>{" "}
                  <span className={s.privacy === "public" ? "warn" : "dim"}>
                    {s.privacy === "public" ? "public" : "encrypted"}
                  </span>
                </div>
                <div className="dim" style={{ marginTop: 2 }}>
                  {s.what}
                </div>
              </td>
              <td style={{ width: 210, verticalAlign: "top" }}>
                <div className="val">{s.rate}</div>
                <div className="dim" style={{ marginTop: 2, lineHeight: 1.4 }}>
                  {s.rateNote}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {demoToken && (
        <p className="note">
          The deposit panel below runs on <strong>gUSDC</strong> ({TOKEN.slice(0, 10)}…), our
          own ERC-7984, because it has a public <span className="mono">mint</span> and you can
          fund yourself in one click. It is the same standard as cUSDC — nothing about the pool
          depends on which one it holds, and{" "}
          <a href="https://sepolia.etherscan.io/address/0x3Eddf704b0909F6A8fa491857533D28C22f9b8d4" target="_blank" rel="noreferrer">
            the same contract runs on Zama&apos;s cUSDC
          </a>{" "}
          to prove it.
        </p>
      )}
    </div>
  );
}

export default Route;
