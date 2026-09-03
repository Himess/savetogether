"use client";
import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr } from "@/lib/format";
import { EXPLORER, POOL } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { oddsPct, rejectionFloor, thresholdFor } from "@/lib/draw";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** The block the current pool was deployed in — bounds the log scan. */
const FROM_BLOCK = 11_600_000n;

interface Row {
  who: `0x${string}`;
  mine: bigint[];
  chain: bigint[];
  match: boolean;
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      style={css(
        "padding:4px 10px;border-radius:999px;white-space:nowrap;font:700 11px var(--display);" +
          (ok
            ? "background:var(--green-bg);border:1px solid #bfe3cd;color:var(--green)"
            : "background:#fdecec;border:1px solid #f3c2c2;color:#a11"),
      )}
    >
      {children}
    </span>
  );
}

/** One row of the public draw record. Reads only what the chain publishes. */
function HistoryRow({ id, onPick }: { id: number; onPick: () => void }) {
  const { data } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [id] });
  const d = data as { status: number; r: bigint; totalWeight: bigint } | undefined;
  const label = d === undefined ? "…" : ["none", "open", "revealed", "cancelled"][Number(d.status)] ?? "?";
  return (
    <tr>
      <td style={css("padding:8px 10px;border-bottom:1px solid var(--line);font-weight:700")}>#{id}</td>
      <td style={css("padding:8px 10px;border-bottom:1px solid var(--line)")}>
        <span style={css("font:650 10.5px var(--display);text-transform:uppercase;letter-spacing:.06em;color:" + (label === "revealed" ? "var(--green)" : label === "cancelled" ? "#a11" : "var(--ink-3)"))}>{label}</span>
      </td>
      <td style={css("padding:8px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--ink-2)")}>
        {d === undefined || Number(d.status) !== 2 ? "—" : String(d.r).slice(0, 12) + "…"}
      </td>
      <td style={css("padding:8px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--ink-2)")}>
        {d === undefined || Number(d.status) !== 2 ? "—" : String(d.totalWeight)}
      </td>
      <td style={css("padding:8px 10px;border-bottom:1px solid var(--line)")}>
        {d !== undefined && Number(d.status) === 2 && (
          <button onClick={onPick} style={css("padding:4px 10px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface-2);font:650 10.5px var(--display);color:var(--ink);cursor:pointer")}>audit</button>
        )}
      </td>
    </tr>
  );
}

/**
 * The draw, recomputed in this browser from public data.
 *
 * This is the project's strongest claim made into something a visitor does
 * rather than reads. Every threshold is a pure function of `r`, the draw id, the
 * address and `totalWeight` — all published at the reveal — so anyone can check
 * that the pool followed its own rule, and `lib/draw.ts` is a second
 * implementation of it rather than a call to the contract.
 *
 * BE PRECISE ABOUT THE SCOPE, because overstating it would be worse than not
 * having the page at all:
 *
 *   anyone            every threshold, and that the sampling is unbiased
 *   a participant     their own weight, and therefore their own result
 *   nobody            anyone else's result
 *
 * The last row is not a gap. It is the product, and this screen is the only
 * place a visitor can see both halves at once.
 */
export function VerifyScreen() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [drawId, setDrawId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myWeightHandle, setMyWeightHandle] = useState<`0x${string}` | null>(null);

  const { data: drawCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { refetchInterval: 20_000 },
  });
  const latest = Number(drawCount ?? 0);
  const target = drawId ?? latest;

  const { data: draw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [target],
    query: { enabled: target > 0 },
  });
  const d = draw as
    | { periodStart: bigint; snapshotAt: bigint; status: number; r: bigint; totalWeight: bigint }
    | undefined;
  const revealed = d !== undefined && Number(d.status) === 2;

  const k0 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [0n] });
  const k1 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [1n] });
  const k2 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [2n] });
  const p0 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [0n] });
  const p1 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [1n] });
  const p2 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [2n] });
  const ks = [k0.data, k1.data, k2.data] as (bigint | undefined)[];
  const prizes = [p0.data, p1.data, p2.data] as (bigint | undefined)[];
  const tiersReady = ks.every((x) => x !== undefined);

  // My own weight, which only I can read — the private half of the audit.
  const { data: hasPermit } = useHasPermit({ contractAddresses: [POOL] }, { enabled: !!address });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();
  const handles = useMemo(
    () => (myWeightHandle && myWeightHandle !== ZERO
      ? [{ encryptedValue: myWeightHandle, contractAddress: POOL as string }]
      : []),
    [myWeightHandle],
  );
  const { data: clear, isFetching } = useDecryptValues(handles, {
    enabled: !!address && hasPermit === true && handles.length > 0,
  });
  const myWeight = myWeightHandle ? (clear?.[myWeightHandle] as bigint | undefined) : undefined;

  const myThresholds = useMemo(() => {
    if (!address || d === undefined || !revealed || !tiersReady) return null;
    return ks.map((k, t) => thresholdFor(BigInt(d.r), target, address, BigInt(d.totalWeight), t, k!));
  }, [address, d, revealed, tiersReady, target, ks]);

  async function verify(): Promise<void> {
    if (client === undefined || d === undefined || !tiersReady) return;
    setRunning(true);
    setError(null);
    setRows(null);
    try {
      // The participant set is PUBLIC — every Deposited event names its
      // depositor. That is stated on the page rather than glossed: this design
      // hides amounts, not identities.
      const head = await client.getBlockNumber();
      const seen = new Set<string>();
      const users: `0x${string}`[] = [];
      for (let from = FROM_BLOCK; from <= head; from += 9_000n) {
        const to = from + 8_999n > head ? head : from + 8_999n;
        const logs = await client.getLogs({
          address: POOL,
          event: {
            type: "event",
            name: "Deposited",
            inputs: [
              { indexed: true, name: "user", type: "address" },
              { indexed: false, name: "timestamp", type: "uint40" },
              { indexed: false, name: "observationIndex", type: "uint256" },
            ],
          },
          fromBlock: from,
          toBlock: to,
        });
        for (const l of logs) {
          const u = (l as unknown as { args: { user: `0x${string}` } }).args.user;
          if (!seen.has(u.toLowerCase())) { seen.add(u.toLowerCase()); users.push(u); }
        }
      }

      const out: Row[] = [];
      for (const who of users) {
        const mine = ks.map((k, t) =>
          thresholdFor(BigInt(d.r), target, who, BigInt(d.totalWeight), t, k!),
        );
        const chain: bigint[] = [];
        for (let t = 0; t < ks.length; t++) {
          chain.push(
            (await client.readContract({
              abi: POOL_ABI,
              address: POOL,
              functionName: "thresholdFor",
              args: [target, who, t],
            })) as bigint,
          );
        }
        out.push({ who, mine, chain, match: mine.every((m, i) => m === chain[i]) });
      }
      setRows(out);
    } catch (e) {
      setError((e as Error).message.slice(0, 200));
    } finally {
      setRunning(false);
    }
  }

  async function revealMyWeight(): Promise<void> {
    if (address === undefined) return;
    setError(null);
    try {
      // Two calls, and both are needed. The transaction persists the ACL grant;
      // the simulation returns the handle, which a receipt does not carry.
      // `weightFor` is not a view — the grant is a state change — so this is
      // `simulateContract` rather than `readContract`.
      await writeContractAsync({
        abi: POOL_ABI, address: POOL, functionName: "weightFor", args: [target, address],
      });
      const sim = await client!.simulateContract({
        abi: POOL_ABI, address: POOL, functionName: "weightFor", args: [target, address],
        account: address,
      });
      setMyWeightHandle(sim.result as `0x${string}`);
    } catch (e) {
      setError((e as Error).message.slice(0, 200));
    }
  }

  const allMatch = rows !== null && rows.length > 0 && rows.every((r) => r.match);

  return (
    <div style={css("max-width:1000px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Verify <span style={css("color:var(--ink-3);font-weight:700")}>· the draw</span>
      </h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:74ch")}>
        Every threshold in this pool is a pure function of public inputs. Your browser can
        recompute all of them and check the contract followed its own rule — without learning
        a single participant&apos;s result, including from the ones it just verified.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      {/* the draw under audit */}
      <div style={css("background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px 22px")}>
        <div style={css("display:flex;align-items:center;gap:12px;flex-wrap:wrap")}>
          <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Draw</span>
          <select
            value={target}
            onChange={(e) => { setDrawId(Number(e.target.value)); setRows(null); setMyWeightHandle(null); }}
            style={css("padding:6px 10px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface-2);font:650 13px var(--display);color:var(--ink)")}
          >
            {Array.from({ length: latest }, (_, i) => latest - i).map((n) => (
              <option key={n} value={n}>#{n}</option>
            ))}
          </select>
          {d !== undefined && (
            <Pill ok={revealed}>{revealed ? "Revealed" : "Not revealed yet"}</Pill>
          )}
        </div>

        {revealed && d !== undefined && (
          <div style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px 26px;margin-top:18px")}>
            <div>
              <span style={css("display:block;font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Randomness (public)</span>
              <span style={css("font:600 12.5px var(--mono);word-break:break-all")}>{String(d.r)}</span>
            </div>
            <div>
              <span style={css("display:block;font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Total weight (public)</span>
              <span style={css("font:600 12.5px var(--mono);word-break:break-all")}>{String(d.totalWeight)}</span>
            </div>
            <div>
              <span style={css("display:block;font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Window</span>
              <span style={css("font:600 12.5px var(--mono)")}>
                {Number(d.snapshotAt) - Number(d.periodStart)}s
              </span>
            </div>
            <div>
              <span style={css("display:block;font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Rejection floor</span>
              <span style={css("font:600 12.5px var(--mono);word-break:break-all")}>
                {String(rejectionFloor(BigInt(d.totalWeight)))}
              </span>
            </div>
          </div>
        )}

        <button
          onClick={() => void verify()}
          disabled={running || !revealed || !tiersReady}
          style={css(`width:100%;margin-top:20px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#ffdf5c,#ffd208);color:#1a1a1a;font:700 14px var(--display);box-shadow:0 5px 15px rgba(255,210,8,.3);cursor:${running || !revealed ? "not-allowed" : "pointer"};opacity:${running || !revealed ? ".55" : "1"}`)}
        >
          {running ? "Recomputing every threshold…" : "Verify this draw in my browser"}
        </button>
        {!revealed && (
          <p style={css("margin:10px 0 0;font:400 11.5px/1.5 var(--display);color:var(--ink-3)")}>
            A draw can only be audited once the KMS has published its randomness. Pick an earlier one.
          </p>
        )}
        {error !== null && (
          <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:#a11")}>{error}</p>
        )}
      </div>

      {/* the public half */}
      {rows !== null && (
        <div style={css("margin-top:22px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px 22px")}>
          <div style={css("display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap")}>
            <span style={css("font:700 15px var(--display)")}>
              {rows.length * 3} thresholds recomputed, {rows.length} participants
            </span>
            <Pill ok={allMatch}>{allMatch ? "all match the contract" : "MISMATCH"}</Pill>
          </div>
          <p style={css("margin:8px 0 0;font:400 12px/1.6 var(--display);color:var(--ink-2)")}>
            The participant list comes from public <span style={css("font-family:var(--mono);font-size:11.5px")}>Deposited</span> events.
            <b style={css("font-weight:650")}> This design hides amounts, not identities</b> — who took part is
            public, and how much they hold, what their odds were and whether they won are not.
          </p>

          <div style={css("overflow-x:auto;margin-top:16px")}>
            <table style={css("width:100%;border-collapse:collapse;font:500 12px var(--display);min-width:560px")}>
              <thead>
                <tr>
                  {["Participant", "Grand", "Middle", "Every draw", "Result"].map((h) => (
                    <th key={h} style={css("text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isMe = address !== undefined && r.who.toLowerCase() === address.toLowerCase();
                  return (
                    <tr key={r.who} style={css(isMe ? "background:var(--accent-soft)" : "")}>
                      <td style={css("padding:9px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11.5px;white-space:nowrap")}>
                        {shortAddr(r.who)}{isMe ? " (you)" : ""}
                      </td>
                      {r.mine.map((m, i) => (
                        <td key={i} style={css("padding:9px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums;white-space:nowrap")}>
                          {m === r.chain[i] ? (
                            <span style={css("color:var(--green);font-weight:650")}>
                              ✓ {((Number(m) / (Number(d!.totalWeight) * Number(ks[i]!))) * 100).toFixed(2)}%
                            </span>
                          ) : (
                            <span style={css("color:#a11;font-weight:700")}>mismatch</span>
                          )}
                        </td>
                      ))}
                      <td style={css("padding:9px 10px;border-bottom:1px solid var(--line);color:var(--ink-3);white-space:nowrap")}>
                        {isMe ? "yours, below" : "not readable by anyone"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={css("margin:14px 0 0;font:400 12px/1.6 var(--display);color:var(--ink-2)")}>
            Every one of those percentages is a threshold this browser recomputed from{" "}
            <span style={css("font-family:var(--mono);font-size:11.5px")}>keccak256(r, drawId, address, tier)</span>{" "}
            and checked against the contract. <b style={css("font-weight:650")}>Not one of the results is
            visible</b> — deciding a row needs that participant&apos;s encrypted weight, and only they can read it.
          </p>
        </div>
      )}

      {/* the private half */}
      {rows !== null && address !== undefined && (
        <div style={css("margin-top:22px;background:var(--panel);border-radius:20px;padding:20px 22px;color:#e9e5da")}>
          <span style={css("font:650 10px var(--display);letter-spacing:.1em;text-transform:uppercase;color:#8b8578")}>Your own result</span>
          <p style={css("margin:10px 0 0;font:400 13px/1.7 var(--display);color:#c9c4b8")}>
            The half nobody else can do. Your weight is encrypted and the permit that reads it lives
            in this browser.
          </p>

          {hasPermit !== true ? (
            <button
              onClick={() => grantPermit([POOL])}
              disabled={granting || !onSepolia}
              style={css("margin-top:14px;padding:11px 18px;border-radius:12px;border:none;background:#ffd208;font:700 13px var(--display);color:#1a1a1a;cursor:pointer")}
            >
              {granting ? "Waiting for signature…" : "Sign once to read my own values"}
            </button>
          ) : myWeightHandle === null ? (
            <button
              onClick={() => void revealMyWeight()}
              disabled={!onSepolia}
              style={css("margin-top:14px;padding:11px 18px;border-radius:12px;border:none;background:#ffd208;font:700 13px var(--display);color:#1a1a1a;cursor:pointer")}
            >
              Compute my weight for draw #{target}
            </button>
          ) : (
            <div style={css("margin-top:16px;display:flex;flex-direction:column;gap:10px")}>
              <div style={css("display:flex;justify-content:space-between;gap:14px;font:600 13px var(--display)")}>
                <span style={css("color:#8b8578")}>my weight</span>
                <span style={css("font-family:var(--mono);font-size:12.5px")}>
                  {isFetching ? "…" : myWeight === undefined ? "•••" : String(myWeight)}
                </span>
              </div>
              {myThresholds !== null && myThresholds.map((th, t) => {
                const label = ["Grand", "Middle", "Every draw"][t];
                const cleared = myWeight !== undefined ? myWeight > th : null;
                return (
                  <div key={t} style={css("display:flex;justify-content:space-between;gap:14px;align-items:baseline;font:500 12.5px var(--display);border-top:1px solid rgba(255,255,255,.08);padding-top:9px")}>
                    <span style={css("color:#c9c4b8")}>
                      {label}
                      <span style={css("color:#8b8578")}>
                        {" · odds "}
                        {myWeight === undefined
                          ? "•••"
                          : oddsPct(myWeight, BigInt(d!.totalWeight), ks[t]!).toFixed(3) + "%"}
                      </span>
                    </span>
                    <span style={css(`font-weight:700;color:${cleared === null ? "#8b8578" : cleared ? "#7ee2a8" : "#8b8578"}`)}>
                      {cleared === null ? "•••" : cleared ? `WON ${Number(prizes[t] ?? 0n) / 1e6} cUSDC` : "not cleared"}
                    </span>
                  </div>
                );
              })}
              <p style={css("margin:8px 0 0;font:400 11.5px/1.6 var(--display);color:#8b8578")}>
                The best tier you cleared is the one credited, never several. This is computed in your
                browser from your own decrypted weight — the chain never published it, and the credit
                reached you whether or not you ever opened this page.
              </p>
            </div>
          )}
        </div>
      )}

      {/* AC5 — the draws that came before, which turn a status page into a
          product. Most rows are "no prize"; that is what makes a win mean
          something, and it is also the honest shape of a lottery. */}
      {latest > 0 && (
        <div style={css("margin-top:22px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px 22px")}>
          <span style={css("font:700 15px var(--display)")}>Every draw so far</span>
          <p style={css("margin:7px 0 0;font:400 12px/1.6 var(--display);color:var(--ink-2)")}>
            The randomness and the aggregate are published at each reveal, so this whole table is
            public. Whether any given participant won is not in it, and cannot be.
          </p>
          <div style={css("overflow-x:auto;margin-top:14px;max-height:340px")}>
            <table style={css("width:100%;border-collapse:collapse;font:500 12px var(--display);min-width:520px")}>
              <thead>
                <tr>
                  {["Draw", "Status", "Randomness", "Total weight", ""].map((h, i) => (
                    <th key={i} style={css("text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: latest }, (_, i) => latest - i).map((n) => (
                  <HistoryRow key={n} id={n} onPick={() => { setDrawId(n); setRows(null); setMyWeightHandle(null); }} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p style={css("margin:20px 2px 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
        Contract{" "}
        <a href={`${EXPLORER}/address/${POOL}#code`} target="_blank" rel="noreferrer" style={css("color:var(--ink-2);font-family:var(--mono);font-size:11px")}>
          {shortAddr(POOL)}
        </a>{" "}
        · the same audit runs headless as{" "}
        <span style={css("font-family:var(--mono);font-size:11px")}>scripts/verify-draw.ts</span>.
      </p>
    </div>
  );
}

export default VerifyScreen;
