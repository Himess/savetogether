"use client";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { fmtUnits6 } from "@/lib/format";
import { POOL, TOKEN } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import {
  accrualSeries,
  averageBalance,
  cumulativeAtLocal,
  oneEvery,
  participated,
  tierOddsPct,
  weightForWindow,
  type DrawWindow,
  type Observation,
} from "@/lib/twab";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const HISTORY = 12; // draws to reconstruct; each costs one read per tier

/** What a multicall entry looks like once wagmi has resolved it. */
type Read<T> = { result?: T; status: "success" | "failure" };

/**
 * The holder's own view.
 *
 * Everything on this screen is computed in this browser from the holder's own
 * decrypted observation record plus data the chain already publishes. Nothing is
 * written, nothing reaches a server, and no permission beyond the decrypt permit
 * the holder already grants elsewhere.
 *
 * TWO RULES, enforced by absence rather than by comment:
 *
 *   - **No shareable link.** There is no route, no query parameter and no copy
 *     control anywhere on this screen. A URL that reproduces these figures would
 *     let a holder disclose themselves with one paste, and the whole design exists
 *     to stop exactly that.
 *   - **Nothing leaves the browser.** No fetch, no analytics, no logging carries a
 *     figure derived here.
 *
 * And three things deliberately NOT built, because each needs numbers that are not
 * the viewer's to read: no leaderboard or rank, no "better than N% of depositors",
 * and no prediction of when they will win. The draw is memoryless — a countdown to
 * a probabilistic event is a lie with a clock on it.
 */
export function Position() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const enabled = !!address;
  const [quote, setQuote] = useState("100");

  const { data: hasPermit } = useHasPermit({ contractAddresses: [POOL, TOKEN] }, { enabled });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  const { data: drawCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { refetchInterval: 20_000 },
  });
  const latest = Number(drawCount ?? 0);

  const { data: obsCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "observationCount",
    args: address ? [address] : undefined, query: { enabled },
  });
  const n = Number(obsCount ?? 0n);

  // ---- the observation record ------------------------------------------------
  const obsCalls = useMemo(
    () =>
      address && n > 0
        ? Array.from({ length: n }, (_, i) => ({
            abi: POOL_ABI, address: POOL, functionName: "observationAt", args: [address, BigInt(i)],
          }))
        : [],
    [address, n],
  );
  const { data: rawObsRaw } = useReadContracts({ contracts: obsCalls as never, query: { enabled: obsCalls.length > 0 } });
  const rawObs = rawObsRaw as unknown as Read<{ timestamp: bigint; balance: string; cumulative: string }>[] | undefined;

  const obsHandles = useMemo(() => {
    const out: { encryptedValue: `0x${string}`; contractAddress: string }[] = [];
    for (const r of rawObs ?? []) {
      const o = r.result;
      if (!o) continue;
      if (o.balance && o.balance !== ZERO) out.push({ encryptedValue: o.balance as `0x${string}`, contractAddress: POOL });
      if (o.cumulative && o.cumulative !== ZERO) out.push({ encryptedValue: o.cumulative as `0x${string}`, contractAddress: POOL });
    }
    return out;
  }, [rawObs]);

  const { data: clear, isFetching } = useDecryptValues(obsHandles, {
    enabled: enabled && hasPermit === true && obsHandles.length > 0,
  });

  const observations: Observation[] | null = useMemo(() => {
    if (!rawObs || hasPermit !== true || clear === undefined) return null;
    const out: Observation[] = [];
    for (const r of rawObs) {
      const o = r.result;
      if (!o) return null;
      const b = o.balance === ZERO ? 0n : clear[o.balance as `0x${string}`];
      const c = o.cumulative === ZERO ? 0n : clear[o.cumulative as `0x${string}`];
      if (b === undefined || c === undefined) return null;
      out.push({
        timestamp: Number(o.timestamp),
        balance: BigInt(b as string | number | bigint),
        cumulative: BigInt(c as string | number | bigint),
      });
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }, [rawObs, hasPermit, clear]);

  // ---- the draws -------------------------------------------------------------
  const ids = useMemo(
    () => Array.from({ length: Math.min(HISTORY, latest) }, (_, i) => latest - i).filter((x) => x > 0),
    [latest],
  );
  const { data: rawDrawsRaw } = useReadContracts({
    contracts: ids.map((id) => ({ abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [id] })) as never,
    query: { enabled: ids.length > 0 },
  });
  const rawDraws = rawDrawsRaw as unknown as
    | Read<{ periodStart: bigint; snapshotAt: bigint; status: number; totalWeight: bigint }>[]
    | undefined;
  const { data: rawAccruedRaw } = useReadContracts({
    contracts: address
      ? (ids.map((id) => ({ abi: POOL_ABI, address: POOL, functionName: "accrued", args: [id, address] })) as never)
      : [],
    query: { enabled: enabled && ids.length > 0 },
  });
  const rawAccrued = rawAccruedRaw as unknown as Read<boolean>[] | undefined;

  const k0 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [0n] });
  const k1 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [1n] });
  const k2 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierK", args: [2n] });
  const p0 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [0n] });
  const p1 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [1n] });
  const p2 = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [2n] });
  const ks = [k0.data, k1.data, k2.data] as (bigint | undefined)[];
  const prizes = [p0.data, p1.data, p2.data] as (bigint | undefined)[];
  const TIER = ["Grand", "Middle", "Every draw"];

  const draws: DrawWindow[] = useMemo(() => {
    const out: DrawWindow[] = [];
    (rawDraws ?? []).forEach((r, i) => {
      const d = r.result;
      if (!d) return;
      out.push({
        id: ids[i]!,
        periodStart: Number(d.periodStart),
        snapshotAt: Number(d.snapshotAt),
        totalWeight: d.totalWeight,
        revealed: Number(d.status) === 2,
      });
    });
    return out;
  }, [rawDraws, ids]);

  // ---- thresholds, one per tier per draw -------------------------------------
  const thCalls = useMemo(
    () =>
      address
        ? draws.flatMap((d) =>
            [0, 1, 2].map((t) => ({
              abi: POOL_ABI, address: POOL,
              functionName: "thresholdFor", args: [d.id, address, t],
            })),
          )
        : [],
    [address, draws],
  );
  const { data: rawThRaw } = useReadContracts({ contracts: thCalls as never, query: { enabled: thCalls.length > 0 } });
  const rawTh = rawThRaw as unknown as Read<bigint>[] | undefined;

  // ---- the holder's history --------------------------------------------------
  const history = useMemo(() => {
    if (observations === null) return null;
    return draws.map((d, i) => {
      const weight = weightForWindow(observations, d);
      const inIt = participated(observations, d);
      const ths = [0, 1, 2].map((t) => rawTh?.[i * 3 + t]?.result);
      const cleared = ths.map((th) => (th === undefined || !d.revealed ? null : weight > th));
      const best = cleared.findIndex((c) => c === true);
      return {
        draw: d,
        weight,
        inIt,
        thresholds: ths,
        cleared,
        bestTier: best >= 0 ? best : null,
        accrued: rawAccrued?.[i]?.result,
      };
    });
  }, [observations, draws, rawTh, rawAccrued]);

  const entered = history?.filter((h) => h.draw.revealed && h.inIt).length ?? null;
  const wins = history?.filter((h) => h.bestTier !== null).length ?? null;

  // ---- odds from the position they hold now ----------------------------------
  const current = draws.find((d) => d.revealed);
  const now = Math.floor(Date.now() / 1000);
  const nowOdds = useMemo(() => {
    if (observations === null || current === undefined || current.totalWeight === 0n) return null;
    const span = current.snapshotAt - current.periodStart;
    if (span <= 0) return null;
    const bal = observations.length ? observations[observations.length - 1]!.balance : 0n;
    const weight = bal * BigInt(span);
    return ks.map((k, t) => ({
      label: TIER[t]!,
      pct: k === undefined ? 0 : tierOddsPct(weight, current.totalWeight, k),
    }));
  }, [observations, current, ks]);

  const quoteOdds = useMemo(() => {
    if (observations === null || current === undefined || current.totalWeight === 0n) return null;
    const v = Number(quote);
    if (!Number.isFinite(v) || v <= 0) return null;
    const span = current.snapshotAt - current.periodStart;
    if (span <= 0) return null;
    const bal = observations.length ? observations[observations.length - 1]!.balance : 0n;
    const extra = BigInt(Math.round(v * 1e6));
    const weight = (bal + extra) * BigInt(span);
    const total = current.totalWeight + extra * BigInt(span);
    return ks.map((k, t) => ({
      label: TIER[t]!,
      pct: k === undefined ? 0 : tierOddsPct(weight, total, k),
    }));
  }, [observations, current, ks, quote]);

  const avg = useMemo(() => {
    if (observations === null || observations.length === 0) return null;
    return averageBalance(observations, observations[0]!.timestamp, now);
  }, [observations, now]);

  const series = useMemo(
    () => (observations === null ? [] : accrualSeries(observations, now)),
    [observations, now],
  );

  const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={css("margin-top:18px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px 20px")}>
      <span style={css("font:650 10px var(--display);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)")}>{title}</span>
      <div style={css("margin-top:12px")}>{children}</div>
    </div>
  );

  return (
    <div style={css("max-width:1000px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Your position
      </h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:74ch")}>
        Every figure here is computed <b style={css("font-weight:650;color:var(--ink)")}>in this
        browser</b>, from your own decrypted record and data the chain already publishes. Nothing is
        written, nothing reaches a server, and there is no link that reproduces it — a URL you could
        paste would be a URL that discloses you.
      </p>

      {!address ? (
        <Panel title="Not connected">
          <p style={css("margin:0;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
            Connect a wallet to reconstruct your own record. Nobody else can do it — not the pool,
            not the keeper, not another depositor.
          </p>
        </Panel>
      ) : hasPermit !== true ? (
        <Panel title="One signature">
          <p style={css("margin:0 0 12px;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
            Your balance history is encrypted. One EIP-712 signature, kept in this browser,
            authorises <i>you</i> to read <i>your own</i> values — it is not a key and no server
            ever sees it.
          </p>
          <button
            onClick={() => grantPermit([POOL, TOKEN])}
            disabled={granting || !onSepolia}
            style={css("padding:11px 18px;border-radius:12px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#24507d,#1b3a5c);font:700 13px var(--display);color:var(--on-accent);cursor:pointer")}
          >
            {granting ? "Waiting for signature…" : "Read my own record"}
          </button>
        </Panel>
      ) : n === 0 ? (
        /* W3. Empty is a valid state and renders as empty. `observationCount` is a
           plaintext read, so this is known before any decryption — the screen used
           to fall through to "Loading your record…" and spin forever for an address
           that had simply never deposited. An absence is not a pending answer. */
        <Panel title="No record yet">
          <p style={css("margin:0;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
            This address has never deposited, so there is nothing to reconstruct. That is a{" "}
            <b style={css("font-weight:650")}>real absence, not a hidden one</b> — no encrypted value
            exists for it, and no amount of waiting will produce one.
          </p>
          <p style={css("margin:9px 0 0;font:400 12.5px/1.7 var(--display);color:var(--ink-3)")}>
            Deposit on the <b style={css("font-weight:650;color:var(--ink-2)")}>Pool</b> screen and
            your weight starts accruing from that moment — it reaches full strength once you have
            held through a whole window, because odds run on how much <i>and for how long</i>.
          </p>
        </Panel>
      ) : observations === null ? (
        <Panel title="Reading">
          <p style={css("margin:0;font:400 13px var(--display);color:var(--ink-2)")}>
            {isFetching ? "Decrypting your observations…" : "Loading your record…"}
          </p>
        </Panel>
      ) : observations.length === 0 ? (
        <Panel title="No record yet">
          <p style={css("margin:0;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
            Nothing to reconstruct for this address.
          </p>
        </Panel>
      ) : (
        <>
          {/* ------------------------------------------------------------ U1 */}
          <Panel title="Your odds this draw · from the position you hold">
            {nowOdds === null ? (
              <p style={css("margin:0;font:400 13px var(--display);color:var(--ink-3)")}>
                No revealed draw to measure against yet.
              </p>
            ) : (
              <>
                {nowOdds.map((r) => (
                  <div key={r.label} style={css("display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:8px 0;border-bottom:1px solid var(--line-2)")}>
                    <span style={css("font:600 13px var(--display)")}>
                      {r.label}
                      <span style={css("display:block;font:400 11px var(--display);color:var(--ink-3)")}>{oneEvery(r.pct)}</span>
                    </span>
                    <span style={css("font:750 16px var(--mono);font-variant-numeric:tabular-nums")}>
                      {r.pct < 0.001 ? "<0.001" : r.pct.toFixed(3)}%
                    </span>
                  </div>
                ))}
                <div style={css("margin-top:14px;display:flex;align-items:center;gap:9px;flex-wrap:wrap")}>
                  <span style={css("font:600 12px var(--display);color:var(--ink-2)")}>If you deposited</span>
                  <input
                    value={quote}
                    onChange={(e) => setQuote(e.target.value.replace(/[^0-9.]/g, ""))}
                    inputMode="decimal"
                    style={css("width:92px;padding:7px 10px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);font:700 13px var(--mono)")}
                  />
                  <span style={css("font:600 12px var(--display);color:var(--ink-2)")}>more</span>
                </div>
                {quoteOdds !== null && (
                  <div style={css("margin-top:9px")}>
                    {quoteOdds.map((q, i) => {
                      const from = nowOdds[i]!.pct;
                      return (
                        <div key={q.label} style={css("display:flex;justify-content:space-between;gap:12px;padding:5px 0;font:400 12px var(--display);color:var(--ink-2)")}>
                          <span>{q.label}</span>
                          <span style={css("font-family:var(--mono);font-size:11.5px")}>
                            {from.toFixed(3)}% <span style={css("color:var(--ink-3)")}>→</span>{" "}
                            <b style={css("font-weight:700;color:var(--ink)")}>{q.pct.toFixed(3)}%</b>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p style={css("margin:10px 0 0;font:400 11px/1.6 var(--display);color:var(--ink-3)")}>
                  Odds run on <b style={css("font-weight:650")}>how much and for how long</b>, so a
                  deposit reaches its full weight only after it has been held for a whole window.
                  These use the last revealed draw&apos;s published aggregate as the divisor.
                </p>
              </>
            )}
          </Panel>

          {/* ------------------------------------------------------------ U3 */}
          <Panel title="Your weight, accruing">
            <TwabChart series={series} />
            <div style={css("margin-top:12px;display:flex;gap:22px;flex-wrap:wrap;font:400 12px var(--display);color:var(--ink-2)")}>
              <span>
                Held now{" "}
                <b style={css("font-weight:700;font-family:var(--mono);color:var(--ink)")}>
                  {fmtUnits6(observations[observations.length - 1]!.balance)}
                </b>
              </span>
              <span>
                Average since your first deposit{" "}
                <b style={css("font-weight:700;font-family:var(--mono);color:var(--ink)")}>
                  {avg === null ? "—" : fmtUnits6(avg)}
                </b>
              </span>
              <span>
                In the pool for{" "}
                <b style={css("font-weight:700;color:var(--ink)")}>
                  {Math.max(1, Math.round((now - observations[0]!.timestamp) / 3600))} h
                </b>
              </span>
            </div>
            <p style={css("margin:10px 0 0;font:400 11px/1.6 var(--display);color:var(--ink-3)")}>
              The average is the number your odds are computed from — not the balance showing today.
              That gap is the whole design: <b style={css("font-weight:650")}>an earlier, smaller
              deposit can outweigh a larger one made late</b>, and this is the only place you can
              see it happen to your own money.
            </p>
          </Panel>

          {/* ------------------------------------------------------------ U2 */}
          <Panel title="Every draw you were in">
            <div style={css("display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px")}>
              <span style={css("font:400 12.5px var(--display);color:var(--ink-2)")}>
                Entered{" "}
                <b style={css("font-weight:750;font-size:15px;color:var(--ink)")}>{entered ?? "—"}</b>{" "}
                revealed draws
              </span>
              <span style={css("font:400 12.5px var(--display);color:var(--ink-2)")}>
                Cleared a tier in{" "}
                <b style={css("font-weight:750;font-size:15px;color:var(--ink)")}>{wins ?? "—"}</b>
              </span>
            </div>
            <div style={css("overflow-x:auto")}>
              <table style={css("width:100%;border-collapse:collapse;font:400 12px var(--display);min-width:520px")}>
                <thead>
                  <tr style={css("text-align:left;color:var(--ink-3)")}>
                    <th style={css("padding:6px 8px;font-weight:600")}>draw</th>
                    <th style={css("padding:6px 8px;font-weight:600")}>your weight</th>
                    <th style={css("padding:6px 8px;font-weight:600")}>best threshold</th>
                    <th style={css("padding:6px 8px;font-weight:600")}>cleared</th>
                    <th style={css("padding:6px 8px;font-weight:600")}>accrued</th>
                  </tr>
                </thead>
                <tbody>
                  {(history ?? []).map((h) => (
                    <tr key={h.draw.id} style={css("border-top:1px solid var(--line-2)")}>
                      <td style={css("padding:8px;font-family:var(--mono);font-size:11.5px")}>#{h.draw.id}</td>
                      <td style={css("padding:8px;font-family:var(--mono);font-size:11px;color:var(--ink-3)")}>
                        {h.inIt ? h.weight.toString() : "not in it"}
                      </td>
                      <td style={css("padding:8px;font-family:var(--mono);font-size:11px;color:var(--ink-3)")}>
                        {h.thresholds[2] === undefined ? "…" : h.thresholds[2].toString()}
                      </td>
                      <td style={css("padding:8px")}>
                        {!h.draw.revealed ? (
                          <span style={css("color:var(--ink-3)")}>not revealed</span>
                        ) : h.bestTier === null ? (
                          <span style={css("color:var(--ink-3)")}>no</span>
                        ) : (
                          <span style={css("font-weight:700;color:var(--green)")}>
                            {TIER[h.bestTier]} · {fmtUnits6(prizes[h.bestTier] ?? 0n)} cUSDC
                          </span>
                        )}
                      </td>
                      <td style={css("padding:8px")}>
                        {h.accrued === undefined ? (
                          <span style={css("color:var(--ink-3)")}>…</span>
                        ) : h.accrued ? (
                          <span style={css("color:var(--green);font-weight:650")}>processed</span>
                        ) : (
                          <span style={css("color:var(--amber);font-weight:650")}>waiting</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={css("margin:11px 0 0;font:400 11px/1.6 var(--display);color:var(--ink-3)")}>
              Most rows say no, and that is what makes a win mean anything. Every column is either
              public (<span style={css("font-family:var(--mono)")}>thresholdFor</span>,{" "}
              <span style={css("font-family:var(--mono)")}>accrued</span>) or your own — the weights
              are recomputed here from your decrypted record with the contract&apos;s own formula,
              so no transaction was needed to fill this in.{" "}
              <b style={css("font-weight:650")}>Cleared is not the same as paid</b>: if the reserve
              could not cover a prize it credits zero, and nothing on chain distinguishes that from
              a loss.
            </p>
          </Panel>

          {/* ------------------------------------------------------------ U4 */}
          {avg !== null && (
            <Panel title="What you gave up">
              <p style={css("margin:0;font:400 13px/1.75 var(--display);color:var(--ink-2)")}>
                Paid pro rata at the pool&apos;s rate, an average balance of{" "}
                <b style={css("font-weight:700;font-family:var(--mono);color:var(--ink)")}>{fmtUnits6(avg)}</b>{" "}
                cUSDC would earn you a slice of each round&apos;s yield — a small, certain number.
                Instead it buys the odds above: <b style={css("font-weight:650;color:var(--ink)")}>you
                give up the interest and take a chance at all of it.</b>
              </p>
              <p style={css("margin:9px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
                And the line that does not move either way is the principal. A round you do not win
                costs you that round&apos;s yield and nothing else — your balance above is untouched
                and withdrawable whenever you like.
              </p>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

/** The holder's balance over time, drawn from their own decrypted observations. */
function TwabChart({ series }: { series: { t: number; balance: bigint; cumulative: bigint }[] }) {
  if (series.length < 2) {
    return (
      <p style={css("margin:0;font:400 12.5px var(--display);color:var(--ink-3)")}>
        One observation so far — the shape appears once you have deposited or withdrawn again.
      </p>
    );
  }
  const W = 640;
  const H = 130;
  const t0 = series[0]!.t;
  const t1 = series[series.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const maxB = series.reduce((m, p) => (p.balance > m ? p.balance : m), 1n);
  const x = (t: number) => ((t - t0) / span) * W;
  const y = (b: bigint) => H - (Number(b) / Number(maxB)) * (H - 14) - 4;

  // A step chart, because a balance is constant between observations rather than
  // interpolating — drawing it as a slope would misstate what was held when.
  let d = `M ${x(series[0]!.t).toFixed(1)} ${y(series[0]!.balance).toFixed(1)}`;
  for (let i = 1; i < series.length; i++) {
    d += ` L ${x(series[i]!.t).toFixed(1)} ${y(series[i - 1]!.balance).toFixed(1)}`;
    d += ` L ${x(series[i]!.t).toFixed(1)} ${y(series[i]!.balance).toFixed(1)}`;
  }
  const area = `${d} L ${W} ${H} L 0 ${H} Z`;

  return (
    <div style={css("overflow-x:auto")}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={css("display:block;min-width:420px")} role="img" aria-label="Your balance over time">
        <path d={area} fill="rgba(27,58,92,.12)" />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {series.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.balance)} r="3" fill="#1a1a1a" />
        ))}
      </svg>
      <div style={css("display:flex;justify-content:space-between;font:400 10.5px var(--mono);color:var(--ink-3)")}>
        <span>{new Date(t0 * 1000).toLocaleString()}</span>
        <span>now</span>
      </div>
    </div>
  );
}
