"use client";

import { explorerTx, type ActionState } from "../lib/tx";

/**
 * One line saying what is happening, and a link to prove it.
 *
 * Deliberately not a toast. A toast disappears, and the interesting moments here
 * — a deposit that took ninety seconds, a signature that was cancelled — are
 * exactly the ones somebody looks back at after glancing away.
 */
export function TxStatus({ state }: { state: ActionState }) {
  if (state.phase === "idle") return null;

  const link =
    state.hash === undefined ? null : (
      <a
        href={explorerTx(state.hash)}
        target="_blank"
        rel="noreferrer"
        className="mono"
        style={{ marginLeft: 8 }}
      >
        {state.hash.slice(0, 10)}…
      </a>
    );

  if (state.phase === "wallet") {
    return (
      <p className="note" style={{ marginTop: 10 }}>
        <strong>{state.label}</strong> — check your wallet and approve it.
      </p>
    );
  }

  if (state.phase === "pending") {
    return (
      <p className="note" style={{ marginTop: 10 }}>
        <strong>{state.label}</strong> — sent, waiting for Sepolia to include it.
        {link}
        <br />
        <span className="dim">
          Confidential transactions carry a proof, so this is slower than an ordinary
          transfer. Fifteen seconds is normal.
        </span>
      </p>
    );
  }

  if (state.phase === "done") {
    return (
      <p className="note" style={{ marginTop: 10 }}>
        <strong>Done.</strong> {state.outcome}
        {link}
      </p>
    );
  }

  return (
    <p className="note warn" style={{ marginTop: 10 }}>
      <strong>{state.label} did not happen.</strong> {state.error}
    </p>
  );
}

export default TxStatus;
