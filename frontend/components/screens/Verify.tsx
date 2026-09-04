"use client";
import { useMemo, useState } from "react";
import { useAccount, useBalance, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr } from "@/lib/format";
import { DEPOSIT_BATCHER, EXPLORER, KEEPER, KEEPER_ETH_PER_DRAW, POOL, REDEEM_BATCHER, VAULT_4626, VAULT_SHARE } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { oddsPct, rejectionFloor, thresholdFor } from "@/lib/draw";
import { weightForWindow, type Observation } from "@/lib/twab";

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
            ? "background:var(--green-bg);border:1px solid #c3ddcf;color:var(--green)"
            : "background:var(--red-bg);border:1px solid #e0c4c4;color:var(--red)"),
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
        <span style={css("font:650 10.5px var(--display);text-transform:uppercase;letter-spacing:.06em;color:" + (label === "revealed" ? "var(--green)" : label === "cancelled" ? "var(--red)" : "var(--ink-3)"))}>{label}</span>
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

  const [drawId, setDrawId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * B2.3 — the weight is computed in this browser, not bought from the chain.
   *
   * This used to call `weightFor(draw, self)` as a TRANSACTION: the ACL grant is
   * a state change, so it cost gas, and the handle only came back from a paired
   * `simulateContract`. Three things were wrong with that beyond the gas.
   *
   * The screen's own headline says anyone can recompute every threshold for any
   * address in any draw, and then showed a disconnected visitor a single sign-in
   * button. The draw selector sat inside the branch its `onChange` collapsed, so
   * the control destroyed the panel containing it. And the default target is the
   * newest draw, which is normally still Open — so the first transaction anyone
   * paid for was guaranteed to come back "pick an earlier one".
   *
   * Worst of it: sending `weightFor(N, self)` minutes after draw N reveals is,
   * to an observer, someone checking their own result. docs/leakage.md:107 sets
   * the rule this broke — "no one has to transact merely to learn whether they
   * won" — and the audit screen was the one place breaking it.
   *
   * `weightForWindow` is exact rather than approximate. It computes
   * `cumulativeAt(snapshotAt) - cumulativeAt(periodStart)`, and the contract's
   * own comment at :925 says why its cached branch is equivalent: for a Revealed
   * predecessor, `periodStart` IS its snapshot.
   */
  const { data: obsCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "observationCount",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const nObs = Number(obsCount ?? 0n);
  const obsCalls = useMemo(
    () =>
      address && nObs > 0
        ? Array.from({ length: nObs }, (_, i) => ({
            abi: POOL_ABI, address: POOL, functionName: "observationAt", args: [address, BigInt(i)],
          }))
        : [],
    [address, nObs],
  );
  const { data: rawObsRaw } = useReadContracts({
    contracts: obsCalls as never, query: { enabled: obsCalls.length > 0 },
  });
  const rawObs = rawObsRaw as unknown as
    | { status: string; result?: { timestamp: bigint; balance: string; cumulative: string } }[]
    | undefined;

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
    () => (obsHandles.length > 0
      ? obsHandles
      : []),
    [obsHandles],
  );
  const { data: clear, isFetching } = useDecryptValues(handles, {
    enabled: !!address && hasPermit === true && handles.length > 0,
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

  const myWeight: bigint | undefined = useMemo(() => {
    if (observations === null || draw === undefined) return undefined;
    const d = draw as unknown as { periodStart: bigint; snapshotAt: bigint };
    if (d.snapshotAt === undefined) return undefined;
    return weightForWindow(observations, {
      id: target,
      periodStart: Number(d.periodStart),
      snapshotAt: Number(d.snapshotAt),
      totalWeight: BigInt((draw as unknown as { totalWeight: bigint }).totalWeight ?? 0n),
      revealed: Number((draw as unknown as { status: number }).status) === 2,
    });
  }, [observations, draw, target]);

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
      {/* P3. This screen already computed both halves and never said what
          they were. The thresholds below are a `view` returning uint128 —
          anyone can compute them, for any address, in any draw. The weight
          is a handle only its owner can decrypt. So an observer holds one
          half of the comparison and can never obtain the other, which is
          the sharpest statement of the boundary available and every number
          in it was already on this screen. */}
      <div style={css("padding:11px 13px;border-radius:11px;background:var(--surface-2);border:1px solid var(--line)")}>
        <div style={css("display:flex;gap:10px;align-items:flex-start")}>
          <span style={css("flex:none;margin-top:2px;padding:2px 7px;border-radius:999px;background:var(--amber-bg);border:1px solid #d9cfbc;font:700 9.5px var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--amber)")}>public</span>
          <p style={css("margin:0;font:400 11.5px/1.6 var(--display);color:var(--ink-2)")}>
            <b style={css("font-weight:650;color:var(--ink)")}>Your thresholds.</b> Recomputed
            below in your browser from <span style={css("font-family:var(--mono);font-size:11px")}>r</span>,
            the draw id and your address — and{" "}
            <b style={css("font-weight:650;color:var(--ink)")}>anyone can compute them</b>, for
            any address, in any draw. They are a plain{" "}
            <span style={css("font-family:var(--mono);font-size:11px")}>view</span> on the
            contract. Nothing about them is secret.
          </p>
        </div>
        <div style={css("margin-top:9px;display:flex;gap:10px;align-items:flex-start")}>
          <span style={css("flex:none;margin-top:2px;padding:2px 7px;border-radius:999px;background:var(--green-bg);border:1px solid #c3ddcf;font:700 9.5px var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--green)")}>yours</span>
          <p style={css("margin:0;font:400 11.5px/1.6 var(--display);color:var(--ink-2)")}>
            <b style={css("font-weight:650;color:var(--ink)")}>Your weight.</b> An encrypted
            handle the contract granted to you and to nobody else. The relayer will not
            return it to another address, however many times it is asked.
          </p>
        </div>
        <p style={css("margin:10px 0 0;padding-top:9px;border-top:1px solid var(--line-2);font:500 11.5px/1.6 var(--display);color:var(--ink)")}>
          So the comparison happens on your side, and only on your side. An observer holds
          one half of it and can never obtain the other —{" "}
          <b style={css("font-weight:650")}>and you cannot make it for anyone else either</b>.
        </p>
      </div>

    {/* The audit is no longer behind this button. Recomputing the draw needs no
        wallet, no signature and no transaction — it is arithmetic over public
        inputs — so it renders for anyone who opens the page, which is what the
        paragraph above it has always claimed. The signature below buys one extra
        thing: YOUR OWN weight, to compare against a threshold anyone can already
        compute for you. */}
    {(
      <div style={css("margin-top:16px;display:flex;flex-direction:column;gap:10px")}>
        {address !== undefined && hasPermit !== true && (
          <button
            onClick={() => grantPermit([POOL])}
            disabled={granting || !onSepolia}
            style={css("align-self:flex-start;padding:11px 18px;border-radius:12px;border:none;background:var(--accent);font:700 13px var(--display);color:var(--on-accent);cursor:pointer")}
          >
            {granting ? "Waiting for signature…" : "Sign once to add my own weight"}
          </button>
        )}

      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      {/* the draw under audit */}
      <div style={css("background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px 22px")}>
        <div style={css("display:flex;align-items:center;gap:12px;flex-wrap:wrap")}>
          <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Draw</span>
          <select
            value={target}
            onChange={(e) => { setDrawId(Number(e.target.value)); setRows(null); }}
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
          style={css(`width:100%;margin-top:20px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#24507d,#1b3a5c);color:var(--on-accent);font:700 14px var(--display);box-shadow:0 5px 15px rgba(27,58,92,.28);cursor:${running || !revealed ? "not-allowed" : "pointer"};opacity:${running || !revealed ? ".55" : "1"}`)}
        >
          {running ? "Recomputing every threshold…" : "Verify this draw in my browser"}
        </button>
        {!revealed && (
          <p style={css("margin:10px 0 0;font:400 11.5px/1.5 var(--display);color:var(--ink-3)")}>
            A draw can only be audited once the KMS has published its randomness. Pick an earlier one.
          </p>
        )}
        {error !== null && (
          <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:var(--red)")}>{error}</p>
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
                            <span style={css("color:var(--red);font-weight:700")}>mismatch</span>
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
        <div style={css("margin-top:22px;background:var(--panel);border-radius:20px;padding:20px 22px;color:#e6e8ea")}>
          <span style={css("font:650 10px var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)")}>Your own result</span>
          <p style={css("margin:10px 0 0;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
            The half nobody else can do. Your weight is encrypted and the permit that reads it lives
            in this browser.
          </p>

              <div style={css("display:flex;justify-content:space-between;gap:14px;font:600 13px var(--display)")}>
                <span style={css("color:var(--ink-3)")}>my weight</span>
                <span style={css("font-family:var(--mono);font-size:12.5px")}>
                  {isFetching ? "…" : myWeight === undefined ? "•••" : String(myWeight)}
                </span>
              </div>
              {myThresholds !== null && myThresholds.map((th, t) => {
                const label = ["Grand", "Middle", "Every draw"][t];
                const cleared = myWeight !== undefined ? myWeight > th : null;
                return (
                  <div key={t} style={css("display:flex;justify-content:space-between;gap:14px;align-items:baseline;font:500 12.5px var(--display);border-top:1px solid rgba(255,255,255,.08);padding-top:9px")}>
                    <span style={css("color:var(--ink-2)")}>
                      {label}
                      <span style={css("color:var(--ink-3)")}>
                        {" · odds "}
                        {myWeight === undefined
                          ? "•••"
                          : oddsPct(myWeight, BigInt(d!.totalWeight), ks[t]!).toFixed(3) + "%"}
                      </span>
                    </span>
                    <span style={css(`font-weight:700;color:${cleared === null ? "var(--ink-3)" : cleared ? "var(--green)" : "var(--ink-3)"}`)}>
                      {cleared === null ? "•••" : cleared ? `cleared · ${Number(prizes[t] ?? 0n) / 1e6} cUSDC` : "not cleared"}
                    </span>
                  </div>
                );
              })}
              <p style={css("margin:8px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
                The best tier you cleared is the one credited, never several. This is computed in your
                browser from your own decrypted weight — the chain never published it, and the credit
                reached you whether or not you ever opened this page.
              </p>
              <p style={css("margin:8px 0 0;padding:9px 11px;border-radius:10px;background:var(--amber-bg);border:1px solid var(--amber-line);font:400 11px/1.6 var(--display);color:var(--amber)")}>
                <b style={css("font-weight:650")}>Cleared is not the same as paid.</b> Clearing a
                threshold is the whole of the public rule, and it is what this page can check. The
                payment is a second step the page cannot see: <span style={css("font-family:var(--mono);font-size:10.5px")}>accrue</span>{" "}
                credits the prize only if the reserve covers it, and a reserve that is short credits
                <b style={css("font-weight:650")}> zero</b> — which on chain is indistinguishable from
                losing. Simulated at 3.2–3.6% of wins per configuration, and 97.3% on a first draw
                against an empty reserve. Compare this against your own decrypted{" "}
                <span style={css("font-family:var(--mono);font-size:10.5px")}>winningsOf</span> on{" "}
                <b style={css("font-weight:650")}>Your position</b>: you are the only party who can.
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
                  <HistoryRow key={n} id={n} onPick={() => { setDrawId(n); setRows(null);  }} />
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

      {/* The keeper's runway.
          Every other figure on this screen is about whether a past draw was fair.
          This one is about whether the next draw happens at all, and it is the
          only operational fact in the product that a reader can act on: openDraw
          and accrueMany are both permissionless. It needs no wallet and no permit
          — a wallet balance is public — so it renders for a visitor who has
          connected nothing. */}
      <KeeperRunway />

      {/* V2. The composition proof, moved here from the retired Vault tab.
          It belongs on the evidence page: its reader wants it, and on the Pool
          screen it sat next to a button that moved the POOL's principal while
          looking like a way to join. */}
      <div style={css("margin-top:26px;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:20px 22px")}>
        <span style={css("font:650 10px var(--display);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)")}>
          The composition, and which half is ours
        </span>
        <p style={css("margin:10px 0 0;font:400 13px/1.7 var(--display);color:var(--ink-2)")}>
          The pool&apos;s principal goes through <b style={css("font-weight:650;color:var(--ink)")}>Zama&apos;s
          deployed deposit batcher</b> and real shares come back — batch 286, on chain, both
          directions. That part is real and checkable.
        </p>
        <div style={css("margin-top:13px;display:flex;flex-direction:column;gap:9px")}>
          {[
            ["Deposit batcher", DEPOSIT_BATCHER, "cUSDC → shares · our principal is in batch 286"],
            ["Redeem batcher", REDEEM_BATCHER, "shares → cUSDC, the way back out"],
            ["Vault share", VAULT_SHARE, "Confidential steakcUSDC — what the batcher actually returns"],
            ["ERC-4626", VAULT_4626, "Steakhouse Confidential Prime USDC"],
          ].map(([label, addr, note]) => (
            <div key={label as string} style={css("display:flex;justify-content:space-between;gap:14px;align-items:baseline;flex-wrap:wrap;border-top:1px solid var(--line-2);padding-top:9px")}>
              <span style={css("font:600 12.5px var(--display)")}>
                {label}
                <span style={css("display:block;font:400 11px var(--display);color:var(--ink-3)")}>{note}</span>
              </span>
              <a href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" style={css("font:600 12px var(--mono);color:var(--accent-ink);text-decoration:underline")}>
                {shortAddr(addr as string)}
              </a>
            </div>
          ))}
        </div>
        <div style={css("margin-top:14px;padding:12px 14px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line-2)")}>
          <p style={css("margin:0;font:400 12px/1.65 var(--display);color:var(--ink-2)")}>
            <b style={css("font-weight:700;color:var(--ink)")}>And the rate is ours.</b> Zama&apos;s
            Sepolia vault is idle-only with no yield adapter, and the chain says so:{" "}
            <span style={css("font-family:var(--mono);font-size:11px")}>totalAssets</span> equals{" "}
            <span style={css("font-family:var(--mono);font-size:11px")}>totalSupply</span> after
            decimal scaling — a share price of exactly <b style={css("font-weight:700")}>1.0</b> — and
            all ten settled batches finalised at an exchange rate of exactly{" "}
            <span style={css("font-family:var(--mono);font-size:11px")}>1.000000</span>. Nothing there
            appreciates, so the prize is funded from a pre-funded pot at a rate we set. The
            composition is real; the yield is not Zama&apos;s.
          </p>
        </div>
        <p style={css("margin:12px 0 0;font:400 11px/1.6 var(--display);color:var(--ink-3)")}>
          <b style={css("font-weight:650;color:var(--ink-2)")}>Operator action, not yours.</b>{" "}
          <span style={css("font-family:var(--mono);font-size:10.5px")}>joinVault()</span> moves half
          of the <i>pool&apos;s</i> remaining principal into the next batch. It is permissionless, so
          anyone may call it, and it does <b style={css("font-weight:650")}>nothing to your own
          position</b> — it is run by the keeper and lives in{" "}
          <span style={css("font-family:var(--mono);font-size:10.5px")}>scripts/keeper.ts</span> rather
          than behind a button here, because a control that moves someone else&apos;s money should not
          sit where a visitor is looking for their own.
        </p>
      </div>
    </div>
  );
}

export default VerifyScreen;


/**
 * How many more draws the keeper can pay for.
 *
 * Deliberately not alarming when it is healthy and deliberately unmissable when
 * it is not: the failure this warns about is silent, and a silent failure with a
 * quiet warning is just a slower silence.
 */
function KeeperRunway() {
  const { data: bal } = useBalance({ address: KEEPER, query: { refetchInterval: 30_000 } });
  const eth = bal === undefined ? null : Number(bal.value) / 1e18;
  const draws = eth === null ? null : Math.floor(eth / KEEPER_ETH_PER_DRAW);
  // ~41 minutes is the observed cadence, not the 300s floor: the keeper waits on
  // Zama's batcher between rounds. Using minPeriod here would triple the answer.
  const hours = draws === null ? null : (draws * 41) / 60;
  const level = draws === null ? "ok" : draws < 12 ? "bad" : draws < 40 ? "warn" : "ok";
  const tone =
    level === "bad" ? "var(--red)" : level === "warn" ? "var(--amber)" : "var(--green)";
  const bg =
    level === "bad" ? "var(--red-bg)" : level === "warn" ? "var(--amber-bg)" : "var(--surface-2)";

  return (
    <div style={css(`margin-top:18px;padding:13px 15px;border-radius:12px;background:${bg};border:1px solid var(--line-2)`)}>
      <div style={css("display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap")}>
        <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>
          Keeper runway
        </span>
        <a
          href={`${EXPLORER}/address/${KEEPER}`}
          target="_blank"
          rel="noreferrer"
          style={css("font-family:var(--mono);font-size:10.5px;color:var(--ink-3);text-decoration:none")}
        >
          {KEEPER.slice(0, 6)}…{KEEPER.slice(-4)} ↗
        </a>
      </div>
      <div style={css("margin-top:8px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap")}>
        <span style={css(`font:800 22px var(--display);font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:${tone}`)}>
          {draws === null ? "—" : `${draws} draws`}
        </span>
        <span style={css("font:400 11.5px var(--display);color:var(--ink-2)")}>
          {eth === null
            ? "reading the keeper's balance…"
            : `${eth.toFixed(4)} ETH at a measured ${KEEPER_ETH_PER_DRAW} per round`}
          {hours !== null && ` · about ${hours < 48 ? `${Math.round(hours)} hours` : `${(hours / 24).toFixed(1)} days`}`}
        </span>
      </div>
      <p style={css("margin:7px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>
        {level === "bad" ? (
          <>
            <b style={css("font-weight:650;color:var(--red)")}>This is nearly out.</b> When it
            empties the current draw stays Open and every later one queues behind it — no error,
            no event, just a clock that stops. Nothing is lost and no deposit is stuck:{" "}
            <span style={css("font-family:var(--mono);font-size:10px")}>withdraw</span> needs no
            draw at all.
          </>
        ) : (
          <>
            The keeper is not privileged — it pays gas, and that is all it does.{" "}
            <span style={css("font-family:var(--mono);font-size:10px")}>openDraw</span> and{" "}
            <span style={css("font-family:var(--mono);font-size:10px")}>accrueMany</span> are
            permissionless, so if this reaches zero the pool is stalled rather than broken and
            anyone may restart it. The rate is measured from this keeper's own spend, and the
            round count uses the observed ~41-minute cadence rather than the 300s floor.
          </>
        )}
      </p>
    </div>
  );
}
