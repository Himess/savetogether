"use client";
import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { keccak256, toHex } from "viem";
import { css } from "@/lib/css";
import { EXPLORER, POOL } from "@/lib/addresses";

/**
 * Is this thing running right now?
 *
 * The site could show a visitor everything except the one thing they most want
 * before depositing: evidence the pool is alive this minute. Seventeen events are
 * emitted and none were read.
 *
 * WHAT IS IN HERE, AND WHAT IS DELIBERATELY NOT.
 *
 * Draw-level and keeper-level events only: DrawOpened, DrawRevealed, Harvested,
 * KeeperPaid, LivenessPaid. Each is a fact about the POOL — a round started, a
 * round settled, yield was collected, somebody was paid for running it.
 *
 * `Accrued` is excluded and that is the whole judgement call. It fires once per
 * participant per draw, so its presence, absence and timing are per-user data:
 * whether a given address has been settled, and how promptly. docs/leakage.md
 * treats accrual completeness as a keeper-liveness property precisely because it
 * is observable per address, and putting a live per-user feed on the front page
 * would promote a surface the design only tolerates because nothing advertises
 * it. `Deposited`, `Withdrawn` and `Claimed` are excluded for the same reason,
 * and more sharply: those are the exact events §8's window solve consumes.
 *
 * They are all public on chain either way. Not repeating them here is the
 * difference between a leak we accept and a leak we amplify.
 */
const SIGS = [
  { ev: "DrawOpened(uint32,uint40,uint40)", label: "draw opened", tone: "var(--accent-ink)" },
  { ev: "DrawRevealed(uint32,uint64,uint128)", label: "draw revealed", tone: "var(--green)" },
  { ev: "Harvested(uint40)", label: "yield harvested", tone: "var(--ink-2)" },
  { ev: "KeeperPaid(address,uint32,uint256)", label: "keeper paid", tone: "var(--ink-3)" },
  { ev: "LivenessPaid(address,uint64)", label: "liveness reward", tone: "var(--amber)" },
] as const;

interface Item {
  readonly label: string;
  readonly tone: string;
  readonly tx: string;
  readonly at: number;
}

function ago(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function Activity({ limit = 8 }: { limit?: number }) {
  const client = usePublicClient();
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const topics = SIGS.map((s) => keccak256(toHex(s.ev)));
      const head = await client.getBlockNumber();
      // Only the recent window: this answers "is it running now", not "what has
      // ever happened", and a full scan would cost a dozen round trips to say so.
      const from = head > 9_000n ? head - 9_000n : 0n;
      const logs = (await client.getLogs({ address: POOL, fromBlock: from, toBlock: head })) as unknown as {
        topics: readonly string[]; transactionHash: string; blockNumber: bigint;
      }[];

      const times = new Map<string, number>();
      const out: Item[] = [];
      for (const l of logs.slice().reverse()) {
        const i = topics.indexOf((l.topics[0] ?? "0x") as `0x${string}`);
        if (i < 0) continue;
        const key = String(l.blockNumber);
        if (!times.has(key)) times.set(key, Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp));
        out.push({ label: SIGS[i]!.label, tone: SIGS[i]!.tone, tx: l.transactionHash, at: times.get(key)! });
        if (out.length >= limit) break;
      }
      setItems(out);
    } catch (e) {
      setErr((e as Error).message.slice(0, 120));
    }
  }, [client, limit]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 60_000);
    return () => clearInterval(h);
  }, [load]);

  const now = Math.floor(Date.now() / 1000);

  return (
    <div style={css("margin-top:18px;padding:13px 15px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line-2)")}>
      <div style={css("display:flex;justify-content:space-between;align-items:baseline;gap:10px")}>
        <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>
          Lately, on this pool
        </span>
        <span style={css("font:400 10.5px var(--display);color:var(--ink-3)")}>the last ~9,000 blocks</span>
      </div>

      {err !== null ? (
        <p style={css("margin:8px 0 0;font:400 11px var(--display);color:var(--ink-3)")}>
          Could not read the chain: {err}
        </p>
      ) : items === null ? (
        <p style={css("margin:8px 0 0;font:400 11px var(--display);color:var(--ink-3)")}>reading the chain…</p>
      ) : items.length === 0 ? (
        // A feed that hangs on "loading" when the keeper is between rounds is
        // worse than no feed, so the quiet case gets a real sentence.
        <p style={css("margin:8px 0 0;font:400 11px/1.6 var(--display);color:var(--ink-3)")}>
          Nothing in the last few hours. Rounds run about 41 minutes apart and the keeper waits on Zama&apos;s
          batcher between them, so a quiet window is ordinary — but if it stays quiet, the keeper may have
          stopped, and <b style={css("font-weight:650")}>Run the pool yourself</b> above is not decoration.
        </p>
      ) : (
        <div style={css("margin-top:9px;display:flex;flex-direction:column;gap:5px")}>
          {items.map((it) => (
            <a
              key={it.tx + it.label + it.at}
              href={`${EXPLORER}/tx/${it.tx}`}
              target="_blank"
              rel="noreferrer"
              style={css("display:flex;justify-content:space-between;align-items:baseline;gap:10px;text-decoration:none")}
            >
              <span style={css(`font:600 11.5px var(--display);color:${it.tone}`)}>{it.label}</span>
              <span style={css("font-family:var(--mono);font-size:10.5px;color:var(--ink-3)")}>
                {ago(Math.max(0, now - it.at))} ↗
              </span>
            </a>
          ))}
        </div>
      )}

      <p style={css("margin:9px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>
        Draw-level and keeper-level events only. <span style={css("font-family:var(--mono);font-size:10px")}>Accrued</span>,{" "}
        <span style={css("font-family:var(--mono);font-size:10px")}>Deposited</span> and{" "}
        <span style={css("font-family:var(--mono);font-size:10px")}>Withdrawn</span> fire per address and are
        left out on purpose — they are public on chain either way, and the difference between a disclosure we
        accept and one we amplify is whether we put it on the front page.
      </p>
    </div>
  );
}
