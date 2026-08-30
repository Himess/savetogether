"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSendTransaction } from "wagmi";
import { useOnSepolia } from "../lib/chain";
import { HOSTED_URL } from "../lib/addresses";

/**
 * Opening a hosted session, and — first — closing one.
 *
 * The revoke panel is rendered above the open panel and works before a session
 * exists, because a user who cannot get out should never have been let in. It
 * sends transactions from the user's own wallet using calldata the server hands
 * over; nothing here depends on the server being alive or honest at the moment
 * the user wants out.
 *
 * The opening order is not a preference. `openSession` recovers a signature that
 * must come from the session key, over a digest that binds the owner, so the
 * server has to generate the key and sign BEFORE the wallet is asked for
 * anything — and it has to know the address to do it. Hence: address first, one
 * request, then one authorisation.
 */

interface Prepared {
  sessionToken: string;
  sessionKeyAddress: string;
  calls: { to: `0x${string}`; data: `0x${string}`; value?: string }[];
  summary: { tokens: string[]; recipients: string[]; readScope: string; ttlHours: number };
}

interface Status {
  live: boolean;
  sessionKeyAddress: string;
  txCount: number;
  revoke: { what: string; to: `0x${string}`; data: `0x${string}` }[];
}

const STORAGE_KEY = "ghostpool.hosted.session";

export function HostedSession() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const { sendTransactionAsync } = useSendTransaction();

  const [budget, setBudget] = useState("500");
  const [token, setToken] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A session survives a reload; the URL is the only thing the user needs back,
  // and losing it to a refresh would mean opening a second session for nothing.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === null) return;
      const parsed = JSON.parse(saved) as { token: string; mcpUrl: string };
      setToken(parsed.token);
      setMcpUrl(parsed.mcpUrl);
    } catch {
      // A private window, or cleared storage. Nothing is lost that the chain
      // does not still hold.
    }
  }, []);

  const refresh = useCallback(async (t: string) => {
    try {
      const res = await fetch(`${HOSTED_URL}/api/session/${t}`);
      if (!res.ok) return;
      setStatus((await res.json()) as Status);
    } catch {
      setError("the hosted server is not reachable — the local install still works");
    }
  }, []);

  useEffect(() => {
    if (token !== null) void refresh(token);
  }, [token, refresh]);

  if (!HOSTED_URL) return null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = () =>
    run("open", async () => {
      const res = await fetch(`${HOSTED_URL}/api/session/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerAddress: address,
          budgets: [{ token: "gUSDC", amount: budget }],
          ttlHours: 24,
          readScope: "balance-visible",
        }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      const prepared = (await res.json()) as Prepared;

      // Sequential. EIP-5792 batching would make this one prompt, and wagmi's
      // useSendCalls does it where the wallet supports it — but a wallet that
      // does not advertise the capability must still be able to open a session,
      // so this is the path that is guaranteed to exist.
      for (const call of prepared.calls) {
        await sendTransactionAsync({
          to: call.to,
          data: call.data,
          ...(call.value === undefined ? {} : { value: BigInt(call.value) }),
        });
      }

      const adopted = await fetch(`${HOSTED_URL}/api/session/adopt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken: prepared.sessionToken }),
      });
      if (!adopted.ok) throw new Error(((await adopted.json()) as { error: string }).error);
      const { mcpUrl: url } = (await adopted.json()) as { mcpUrl: string };

      setToken(prepared.sessionToken);
      setMcpUrl(url);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: prepared.sessionToken, mcpUrl: url }));
      } catch {
        // Not fatal: the URL is on screen.
      }
      await refresh(prepared.sessionToken);
    });

  const revoke = () =>
    run("revoke", async () => {
      if (status === null) throw new Error("nothing to revoke");
      for (const call of status.revoke) {
        await sendTransactionAsync({ to: call.to, data: call.data });
      }
      if (token !== null) await refresh(token);
    });

  return (
    <section className="panel">
      <h2>Talk to the pool</h2>

      {/* Revocation first, deliberately. It works whether or not a session is
          open, and it is the answer to the only question that matters before
          handing anything a key. */}
      {status !== null && (
        <div className="banner">
          <div>
            <strong>{status.live ? "Session live" : "Session closed"}</strong>{" "}
            <span className="mono">{status.sessionKeyAddress.slice(0, 10)}…</span>
            {status.live && <> · {status.txCount} transactions so far</>}
          </div>
          {status.live && (
            <button className="ghost" onClick={revoke} disabled={!onSepolia || busy !== null}>
              {busy === "revoke" ? "Revoking…" : `Revoke (${status.revoke.length} tx)`}
            </button>
          )}
        </div>
      )}

      {status !== null && status.live && (
        <ul className="note note--plain" style={{ marginTop: 8 }}>
          {status.revoke.map((r) => (
            <li key={r.what}>{r.what}</li>
          ))}
        </ul>
      )}

      {mcpUrl === null ? (
        <>
          <p className="note">
            Sign once and get a URL you paste into Claude&apos;s connector settings. The
            server holds a session key it cannot use beyond the budget you set here — and
            you close it from this wallet, without asking the server for anything.
          </p>
          <div className="row">
            <label htmlFor="hosted-budget">Budget</label>
            <input
              id="hosted-budget"
              value={budget}
              inputMode="decimal"
              onChange={(e) => setBudget(e.target.value)}
            />
            <span className="dim">gUSDC · 24 hours</span>
            <button  onClick={open} disabled={!onSepolia || busy !== null}>
              {busy === "open" ? "Opening…" : "Open a session"}
            </button>
          </div>
          {!onSepolia && (
            <p className="note warn">
              Connect a wallet on Sepolia first. Reads come from Sepolia either way, but a
              transaction built for another chain is one your wallet cannot pay for.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="note">
            Paste this into Claude → Settings → Connectors → Add custom connector.
          </p>
          <div className="row">
            <input readOnly value={mcpUrl} className="mono" style={{ flex: 1 }} />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(mcpUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="note note--plain">
            This URL is a credential. Anyone holding it can spend up to the remaining
            budget, to the addresses on the allowlist, until it expires or you revoke.
          </p>
        </>
      )}

      {error !== null && <p className="note warn">{error}</p>}
    </section>
  );
}

export default HostedSession;
