"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useReadContract, useSendTransaction } from "wagmi";
import { css } from "@/lib/css";
import { fmtUnits6, shortAddr, showConfidential } from "@/lib/format";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { EXPLORER, HOSTED_URL, MODULE, TOKEN } from "@/lib/addresses";
import { MODULE_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { humanise } from "@/lib/tx";
import { useToast } from "@/components/Toast";

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
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Handing a key to something that cannot misuse it.
 *
 * This is the screen the product exists for. A server holds a session key and
 * acts on your behalf in a chat, and the reason that is not reckless is on
 * chain rather than in a promise: the spend is clamped against an `euint64`
 * nobody can read, the recipients are an allowlist, the expiry is fixed, and you
 * close it from this wallet without asking the server for anything.
 *
 * REVOCATION IS RENDERED FIRST and works before a session exists, because
 * somebody deciding whether to open one should be able to see how they get out.
 * The calldata comes from the server but is sent by the user's own wallet, so
 * getting out never depends on the server being alive or honest.
 */
export function ChatScreen() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const { sendTransactionAsync } = useSendTransaction();
  const toast = useToast();

  const [budget, setBudget] = useState("500");
  const [token, setToken] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === null) return;
      const parsed = JSON.parse(saved) as { token: string; mcpUrl: string };
      setToken(parsed.token);
      setMcpUrl(parsed.mcpUrl);
    } catch {
      // Private window, or cleared storage. Nothing is lost that the chain does
      // not still hold.
    }
  }, []);

  const refresh = useCallback(async (t: string) => {
    try {
      // W1. The token is a credential, so it travels in a header and never in a
      // path. In the URL it landed in the browser console, the server's access
      // log, browser history and any Referer — a devtools screenshot published a
      // live session that can spend the remaining budget.
      const res = await fetch(`${HOSTED_URL}/api/session`, {
        headers: { authorization: `Bearer ${t}` },
      });
      if (!res.ok) return;
      setStatus((await res.json()) as Status);
    } catch {
      toast("The hosted server is not reachable — the local install still works", "err");
    }
  }, [toast]);

  useEffect(() => {
    if (token !== null) void refresh(token);
  }, [token, refresh]);

  // What the session key has to work with. The budget handle is granted to the
  // owner at open as well as to the key, so this is the one confidential number
  // about the session that the person who created it can actually read.
  const key = status?.sessionKeyAddress as `0x${string}` | undefined;
  const { data: gas } = useBalance({ address: key, query: { enabled: !!key } });
  const { data: remainingHandle } = useReadContract({
    abi: MODULE_ABI, address: MODULE, functionName: "remainingOf",
    args: key ? [key, TOKEN] : undefined,
    query: { enabled: !!key, refetchInterval: 20_000 },
  });
  const { data: hasPermit } = useHasPermit({ contractAddresses: [MODULE] }, { enabled: !!key });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();
  const budgetInputs = useMemo(
    () =>
      remainingHandle && remainingHandle !== ZERO
        ? [{ encryptedValue: remainingHandle as `0x${string}`, contractAddress: MODULE }]
        : [],
    [remainingHandle],
  );
  const { data: budgetClear, isFetching: readingBudget } = useDecryptValues(budgetInputs, {
    enabled: hasPermit === true && budgetInputs.length > 0,
  });
  // Third copy of the same five states, now the shared one. See lib/format.ts.
  const remaining = useMemo(
    () =>
      showConfidential({
        connected: !!address,
        handle: remainingHandle,
        permitted: hasPermit === true,
        fetching: readingBudget,
        clear: remainingHandle ? budgetClear?.[remainingHandle as `0x${string}`] : undefined,
      }),
    [address, remainingHandle, hasPermit, readingBudget, budgetClear],
  );

  if (!HOSTED_URL) return null;

  const open = async () => {
    if (address === undefined) { toast("Connect your wallet first", "err"); return; }
    setBusy("open");
    try {
      const res = await fetch(`${HOSTED_URL}/api/session/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerAddress: address,
          budgets: [{ token: "cUSDC", amount: budget }],
          ttlHours: 24,
          readScope: "balance-visible",
        }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      const prepared = (await res.json()) as Prepared;

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
      } catch { /* the URL is on screen either way */ }
      await refresh(prepared.sessionToken);
      toast("Session open · paste the URL into Claude");
    } catch (e) {
      toast(humanise(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (status === null) return;
    setBusy("revoke");
    try {
      for (const call of status.revoke) {
        await sendTransactionAsync({ to: call.to, data: call.data });
      }
      if (token !== null) await refresh(token);
      toast("Revoked · the URL can no longer spend");
    } catch (e) {
      toast(humanise(e), "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={css("max-width:1200px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Talk to it <span style={css("color:var(--ink-3);font-weight:700")}>· MCP</span>
      </h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:72ch")}>
        Approve four calls once, paste a URL into Claude, then just say what you want. No terminal, no npm, and
        nothing running on your machine.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      <div style={css("display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start")}>
        <div style={css("flex:1 1 470px;min-width:0")}>
          <div style={css("background:var(--panel);border-radius:20px;padding:22px 24px;color:#e6e8ea")}>
            <span style={css("font:650 10px var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)")}>What it sounds like</span>
            <div style={css("margin-top:14px;display:flex;flex-direction:column;gap:12px")}>
              {[
                "open a session with a 500 cUSDC budget",
                "what's the draw status?",
                "put half my balance in the pool",
                "how much do I have in there?",
              ].map((line) => (
                <div key={line} style={css("display:flex;gap:10px;align-items:flex-start")}>
                  <span style={css("font:700 10px var(--mono);color:#6f6a5e;margin-top:4px;flex:none")}>YOU</span>
                  <span style={css("font:500 14px/1.5 var(--display);color:#f2eee4")}>{line}</span>
                </div>
              ))}
            </div>
            <p style={css("margin:16px 0 0;font:400 12.5px/1.6 var(--display);color:var(--ink-3)")}>
              &ldquo;Half my balance&rdquo; is resolved as a reference, not a number. The model is handed
              <span style={css("font-family:var(--mono);font-size:12px;color:var(--ink-3)")}> bal_1:half</span> and never sees the
              figure — that is the difference between an agent that can spend for you and one that knows what you have.
            </p>
            <p style={css("margin:10px 0 0;font:400 12px/1.6 var(--display);color:var(--ink-3)")}>
              It does <em>not</em> keep the figure from the session client, which has to know your
              balance to halve it and to encrypt anything at all. That is a real cost and the table
              below states it rather than leaving it to be assumed.
            </p>
          </div>

          {/* Who knows what. Three principals, because collapsing the middle one is
              how a custodial product sounds safe. */}
          <div style={css("margin-top:26px;background:var(--surface-2);border:1px solid var(--line);border-radius:16px;padding:18px 20px")}>
            <div style={css("font:800 15px var(--display);letter-spacing:-.01em")}>Who knows what</div>
            <p style={css("margin:6px 0 0;font:400 12px/1.6 var(--display);color:var(--ink-3)")}>
              Three parties, not two. The <strong>model</strong> holds what you typed and opaque
              references. The <strong>session client</strong> builds the ciphertext, so it holds
              absolute amounts. The <strong>chain</strong> holds neither.
            </p>
            <div style={css("margin-top:12px;overflow-x:auto")}>
              <table style={css("width:100%;border-collapse:collapse;font:400 12px var(--display);min-width:520px")}>
                <thead>
                  <tr style={css("text-align:left;color:var(--ink-3)")}>
                    <th style={css("padding:7px 8px;font-weight:600")}></th>
                    <th style={css("padding:7px 8px;font-weight:600")}>model</th>
                    <th style={css("padding:7px 8px;font-weight:600")}>session client</th>
                    <th style={css("padding:7px 8px;font-weight:600")}>chain</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["pool_deposit, a number you typed", "sees it", "sees it", "encrypted"],
                    ["pool_deposit, bal_1:half", "reference only", "resolves it", "encrypted"],
                    ["pool_position", "reference only", "sees it", "encrypted"],
                    ["can_afford", "one bit; repeated calls reach the bucket floor and stop", "the exact budget", "encrypted"],
                    ["Session budget", "never", "the exact figure", "encrypted, unreadable by anyone"],
                    ["Recipient address", "sees it", "sees it", "public by construction"],
                    ["unwrap", "sees the ceiling", "sees the amount", "published — that is the point"],
                  ].map((r) => (
                    <tr key={r[0]} style={css("border-top:1px solid var(--line-2)")}>
                      <td style={css("padding:8px;font-family:var(--mono);font-size:11px")}>{r[0]}</td>
                      <td style={css("padding:8px")}>{r[1]}</td>
                      <td style={css("padding:8px")}>{r[2]}</td>
                      <td style={css("padding:8px;color:var(--ink-3)")}>{r[3]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={css("margin:12px 0 0;font:400 11.5px/1.65 var(--display);color:var(--ink-3)")}>
              <strong>The leak was never in the cryptography.</strong> <span style={css("font-family:var(--mono);font-size:11px")}>can_afford</span>{" "}
              always decrypted the budget to answer it, so the ciphertext never gave way. What
              leaked was the <em>shape of the answer</em> crossing to the model: a free,
              repeatable, caller-chosen predicate is an oracle whatever it is computed over.
              Forty probes recovered an exact budget. It now answers against a 50-token bucket —
              run the attack yourself on <strong>Try to break it</strong>, row 5.
            </p>
          </div>

          <div style={css("margin-top:26px;background:var(--surface-2);border:1px solid var(--line);border-radius:16px;padding:18px 20px")}>
            <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Why handing over a key is not reckless</span>
            <ul style={css("margin:12px 0 0;padding-left:18px;font:400 13.5px/1.75 var(--display);color:var(--ink-2)")}>
              <li>Every spend is clamped against an <b style={css("color:var(--ink);font-weight:650")}>encrypted budget</b> nobody — including us — can read.</li>
              <li>An <b style={css("color:var(--ink);font-weight:650")}>allowlist</b> bounds where value can go, and an expiry bounds how long.</li>
              <li>Your wallet key <b style={css("color:var(--ink);font-weight:650")}>never leaves your browser</b>. The server has never held one.</li>
              <li>You revoke from this wallet, and the server re-checks the chain on every request — so it takes effect without the server being told.</li>
            </ul>
            <p style={css("margin:14px 0 0;font:400 12.5px/1.6 var(--display);color:var(--ink-3)")}>
              And the part that is not reassuring: a compromised server can spend up to the remaining budget, to the
              allowlisted addresses, until you revoke. It cannot exceed the budget, send anywhere else, or extend itself.
            </p>
          </div>
        </div>

        {/* ------------------------------------------------------- right rail --- */}
        <div style={css("flex:1 1 340px;max-width:400px;position:sticky;top:14px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:0 1px 2px rgba(20,18,12,.03),0 12px 34px rgba(20,18,12,.05);padding:18px")}>
          {status !== null && (
            <div style={css(`border-radius:14px;padding:13px 15px;margin-bottom:14px;${status.live ? "background:var(--green-bg);border:1px solid #c3ddcf" : "background:var(--surface-2);border:1px solid var(--line)"}`)}>
              <div style={css("display:flex;align-items:center;justify-content:space-between;gap:10px")}>
                <div>
                  <div style={css(`font:700 12.5px var(--display);${status.live ? "color:var(--green)" : "color:var(--ink-2)"}`)}>
                    {status.live ? "Session live" : "Session closed"}
                  </div>
                  <div style={css("font:600 11.5px var(--mono);color:var(--ink-3);margin-top:3px")}>
                    {shortAddr(status.sessionKeyAddress)} · {status.txCount} tx
                  </div>
                </div>
                {status.live && (
                  <button
                    onClick={revoke}
                    disabled={busy !== null || !onSepolia}
                    style={css("padding:8px 13px;border-radius:10px;border:1px solid #e5b4b4;background:var(--red-bg);font:650 11.5px var(--display);color:var(--red);cursor:pointer;white-space:nowrap")}
                  >
                    {busy === "revoke" ? "Revoking…" : `Revoke (${status.revoke.length})`}
                  </button>
                )}
              </div>

              {/* What the session key actually has. The budget is the number that
                  matters and the owner CAN read it — it is granted to them as
                  well as to the key at open. Gas is public. The key's own token
                  balance is deliberately absent: the ACL grants that to the key
                  alone, and showing a blank where it would go would suggest a
                  gap rather than a rule. */}
              {status.live && (
                <div style={css("margin-top:12px;padding-top:11px;border-top:1px solid rgba(0,0,0,.07)")}>
                  <div style={css("display:flex;justify-content:space-between;align-items:baseline")}>
                    <span style={css("font:500 11.5px var(--display);color:var(--ink-2)")}>Budget left</span>
                    <span style={css("font:750 15px var(--display);font-variant-numeric:tabular-nums")}>
                      {remaining} <span style={css("font:600 11px var(--mono);color:var(--ink-3)")}>cUSDC</span>
                    </span>
                  </div>
                  <div style={css("display:flex;justify-content:space-between;align-items:baseline;margin-top:4px")}>
                    <span style={css("font:500 11.5px var(--display);color:var(--ink-2)")}>Gas it can spend</span>
                    <span style={css("font:650 12.5px var(--mono);font-variant-numeric:tabular-nums;color:var(--ink-2)")}>
                      {gas === undefined ? "…" : `${Number(gas.formatted).toFixed(4)} ETH`}
                    </span>
                  </div>
                  {hasPermit !== true && (
                    <button
                      onClick={() => grantPermit([MODULE])}
                      disabled={granting || !onSepolia}
                      style={css("width:100%;margin-top:10px;padding:8px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface);font:650 11.5px var(--display);color:var(--ink);cursor:pointer")}
                    >
                      {granting ? "Waiting for signature…" : "Decrypt the budget"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {mcpUrl === null ? (
            <>
              <div style={css("border:1px solid var(--line);border-radius:14px;padding:14px 16px")}>
                <div style={css("font:600 12px var(--display);color:var(--ink-2);margin-bottom:6px")}>Session budget</div>
                <div style={css("display:flex;align-items:center;gap:10px")}>
                  <input
                    value={budget}
                    onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
                    inputMode="decimal"
                    style={css("border:none;outline:none;background:none;font:750 28px var(--display);color:var(--ink);flex:1;min-width:0;padding:0;font-variant-numeric:tabular-nums")}
                  />
                  <span style={css("padding:6px 11px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line-2);font:650 12.5px var(--mono);color:var(--ink);flex:none")}>cUSDC</span>
                </div>
              </div>
              <p style={css("margin:10px 2px 0;font:400 11.5px/1.5 var(--display);color:var(--ink-3)")}>
                This is the ceiling, encrypted on chain. The session can never move more than this, whatever it is asked.
                It expires in 24 hours regardless.
              </p>
              <button
                onClick={open}
                disabled={busy !== null || !onSepolia || !address}
                style={css(`width:100%;margin-top:14px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#24507d,#1b3a5c);color:var(--on-accent);font:700 14px var(--display);box-shadow:0 5px 15px rgba(27,58,92,.28);cursor:pointer;opacity:${busy !== null || !onSepolia || !address ? ".55" : "1"}`)}
              >
                {busy === "open" ? "Opening…" : "Open a session"}
              </button>
              {!onSepolia && (
                <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:var(--amber)")}>
                  Connect a wallet on Sepolia first.
                </p>
              )}
            </>
          ) : (
            <>
              <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Your connector URL</span>
              <p style={css("margin:8px 0 10px;font:400 12px/1.5 var(--display);color:var(--ink-2)")}>
                Claude → Settings → Connectors → Add custom connector.
              </p>
              <div style={css("display:flex;gap:8px")}>
                <input
                  readOnly
                  value={mcpUrl}
                  style={css("flex:1;min-width:0;padding:10px 12px;border-radius:11px;border:1px solid var(--line-2);background:var(--surface-2);font:600 11px var(--mono);color:var(--ink-2)")}
                />
                <button
                  onClick={() => { void navigator.clipboard.writeText(mcpUrl); toast("Copied"); }}
                  style={css("padding:10px 14px;border-radius:11px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#24507d,#1b3a5c);font:700 12px var(--display);color:var(--on-accent);cursor:pointer;flex:none")}
                >
                  Copy
                </button>
              </div>
              <p style={css("margin:12px 2px 0;font:400 11.5px/1.5 var(--display);color:var(--amber)")}>
                This URL is a credential. Anyone holding it can spend up to the remaining budget, to the addresses on the
                allowlist, until it expires or you revoke.
              </p>
              {status !== null && status.live && (
                <ul style={css("margin:14px 0 0;padding-left:16px;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
                  {status.revoke.map((r) => <li key={r.what}>{r.what}</li>)}
                </ul>
              )}
            </>
          )}

          <div style={css("margin-top:16px;padding-top:14px;border-top:1px solid var(--line)")}>
            <a
              href={`${EXPLORER}/address/${status?.sessionKeyAddress ?? ""}`}
              target="_blank"
              rel="noreferrer"
              style={css(`font:600 11.5px var(--display);color:var(--ink-3);text-decoration:none;${status === null ? "display:none" : ""}`)}
            >
              See the session key on Etherscan →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatScreen;
