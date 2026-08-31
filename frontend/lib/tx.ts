"use client";

import { useCallback, useState } from "react";
import { usePublicClient } from "wagmi";
import { EXPLORER } from "./addresses";

/**
 * What a transaction is doing, said out loud.
 *
 * Every action on this page used to be `try { … } finally { setBusy(null) }`
 * with no catch. A rejected signature became an unhandled promise rejection in
 * the console and, on screen, a button that flickered and went back to normal —
 * so someone who cancelled in their wallet, or whose wallet silently failed to
 * send, saw exactly what someone who succeeded saw: nothing.
 *
 * The phases are separated because they fail differently and a user can act on
 * the difference. Waiting for a wallet means look at your wallet. Waiting for a
 * block means wait. An error means read it.
 */
export type Phase = "idle" | "wallet" | "pending" | "done" | "error";

export interface ActionState {
  readonly phase: Phase;
  /** What is being done, in the user's terms. */
  readonly label: string;
  readonly hash?: `0x${string}`;
  readonly error?: string;
  /** Shown when it lands, so "done" says what actually changed. */
  readonly outcome?: string;
}

const IDLE: ActionState = { phase: "idle", label: "" };

/**
 * Turns a wallet's error into something a person can act on.
 *
 * A cancelled signature is the single most common outcome on a testnet demo and
 * it is not a failure of the app; saying so plainly stops people hunting for a
 * bug that is not there.
 */
export function humanise(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; name?: string };
  const text = err.shortMessage ?? err.message ?? String(e);

  if (/user rejected|denied transaction|user denied/i.test(text)) {
    return "You cancelled it in your wallet. Nothing was sent.";
  }
  if (/insufficient funds/i.test(text)) {
    return "Not enough Sepolia ETH for gas in this wallet.";
  }
  if (/chain|network/i.test(text) && /mismatch|unsupported|switch/i.test(text)) {
    return "Your wallet is on another network. Switch it to Sepolia.";
  }
  // Wallet errors run to paragraphs; the first line carries the meaning.
  return text.split("\n")[0]!.slice(0, 200);
}

export function useAction(): {
  state: ActionState;
  run: (label: string, outcome: string, fn: () => Promise<unknown>) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<ActionState>(IDLE);
  const client = usePublicClient();

  const run = useCallback(
    async (label: string, outcome: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setState({ phase: "wallet", label });
      try {
        const result = await fn();
        const hash =
          typeof result === "string" && result.startsWith("0x") && result.length === 66
            ? (result as `0x${string}`)
            : undefined;

        if (hash !== undefined && client !== undefined) {
          setState({ phase: "pending", label, hash });
          // Waiting for the receipt is the difference between "sent" and
          // "happened". Encrypted balances only move on the second one, so
          // reporting the first would be a lie the next screen contradicts.
          await client.waitForTransactionReceipt({ hash });
        }

        setState({ phase: "done", label, outcome, ...(hash === undefined ? {} : { hash }) });
        return true;
      } catch (e) {
        setState({ phase: "error", label, error: humanise(e) });
        return false;
      }
    },
    [client],
  );

  return { state, run, reset: () => setState(IDLE) };
}

export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
