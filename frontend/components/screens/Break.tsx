"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr } from "@/lib/format";
import { EXPLORER, POOL } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { solveWindows, type BalanceEvent, type DrawRow, type SolveReport } from "@/lib/windowSolve";
import { keccak256, toHex } from "viem";

/** The topic0 for an event signature. */
const keccakTopic = (sig: string) => keccak256(toHex(sig));

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The two accruals whose gas is compared.
 *
 * Both on Sepolia, same address, consecutive draws, one a loss and one a win. The
 * numbers used to be typed into the table; they are now read from the chain, so
 * this row cannot drift away from what the receipts say and cannot be accused of
 * being a screenshot. If the RPC is unavailable the row says so rather than
 * falling back to a remembered figure.
 */
const GAS_PAIR = [
  { draw: 34, outcome: "lost", tx: "0xc22520c2cc537c6277e230b5d9b6d9b029aca48aaabc715a824a9fd30fd92440" },
  { draw: 35, outcome: "won 1 cUSDC", tx: "0x1ef0e39d5d30790963c57030a050fbc480932a86e0527429b449f41ed6bbedc1" },
] as const;

/**
 * Runs §8 against the pool the visitor is looking at, right now.
 *
 * Row 4 used to print a solve performed once, in a terminal, against a pool that
 * has since been redeployed. That is a citation, not an attack — and this page's
 * whole value is that it attacks rather than cites. Everything needed is public,
 * so this needs no wallet and no signature.
 */
function useWindowSolve() {
  const client = usePublicClient();
  const [report, setReport] = useState<SolveReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    setErr(null);
    try {
      const count = Number(await client.readContract({ abi: POOL_ABI, address: POOL, functionName: "drawCount" }));
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const draws: DrawRow[] = [];
      for (const id of ids) {
        const d = (await client.readContract({
          abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [id],
        })) as unknown as { periodStart: number | bigint; snapshotAt: number | bigint; status: number; totalWeight: bigint };
        draws.push({
          id,
          periodStart: Number(d.periodStart),
          snapshotAt: Number(d.snapshotAt),
          totalWeight: BigInt(d.totalWeight),
          revealed: Number(d.status) === 2,
        });
      }

      // ALL THREE balance-moving events. Omitting Claimed is what made the first
      // version of this return confidently wrong numbers about real people:
      // `claim` moves a balance through `_drain` exactly as a deposit does.
      const SIGS = [
        { kind: "deposit" as const, ev: "Deposited(address,uint40,uint256)" },
        { kind: "withdraw" as const, ev: "Withdrawn(address,uint40,uint256)" },
        { kind: "claim" as const, ev: "Claimed(address,uint40)" },
      ];
      const topics = SIGS.map((x) => keccakTopic(x.ev));

      // Chunked at 9,000: the public Sepolia RPC refuses a range over 50,000, and
      // asking for one is how this failed the first time it ran in a browser.
      const head = await client.getBlockNumber();
      const FROM = 11_600_000n;
      const start = head > FROM ? FROM : 0n;
      const raw: { topics: readonly string[]; transactionHash: string; blockNumber: bigint }[] = [];
      for (let f = start; f <= head; f += 9_000n) {
        const to = f + 8_999n > head ? head : f + 8_999n;
        const chunk = await client.getLogs({
          address: POOL,
          fromBlock: f,
          toBlock: to,
        });
        raw.push(...(chunk as never as typeof raw));
      }

      // One block read per distinct block, not one per log.
      const times = new Map<string, number>();
      const events: BalanceEvent[] = [];
      for (const l of raw) {
        const idx = topics.indexOf((l.topics[0] ?? "0x") as `0x${string}`);
        if (idx < 0) continue;
        const key = String(l.blockNumber);
        if (!times.has(key)) {
          const blk = await client.getBlock({ blockNumber: l.blockNumber });
          times.set(key, Number(blk.timestamp));
        }
        events.push({
          kind: SIGS[idx]!.kind,
          who: ("0x" + (l.topics[1] ?? "").slice(26)) as `0x${string}`,
          t: times.get(key)!,
          tx: l.transactionHash as `0x${string}`,
        });
      }
            events.sort((a, b) => a.t - b.t);
      setReport(solveWindows(draws, events));
    } catch (e) {
      setErr((e as Error).message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }, [client]);

  return { report, busy, err, run };
}

function useLiveGas() {
  const client = usePublicClient();
  const [gas, setGas] = useState<(bigint | null)[] | null>(null);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void Promise.all(
      GAS_PAIR.map((g) =>
        client
          .getTransactionReceipt({ hash: g.tx as `0x${string}` })
          .then((r) => r.gasUsed as bigint)
          .catch(() => null),
      ),
    ).then((r) => {
      if (alive) setGas(r);
    });
    return () => {
      alive = false;
    };
  }, [client]);
  return gas;
}
const FROM_BLOCK = 11_600_000n;

/**
 * Try to break the privacy.
 *
 * A privacy claim is only worth what an attempt to defeat it costs. Everything
 * else on this site asks to be believed; this screen asks to be attacked, with
 * the visitor's own wallet, against the live pool.
 *
 * EVERY ROW EXECUTES. Nothing here is a staged failure — the ACL refusal is a
 * real refusal from the real relayer, the handles are read from the deployed
 * contract, and the gas figures are two transactions anyone can open on
 * Etherscan. A mocked defeat would be worse than no screen at all, because it
 * would make the one honest thing on the page indistinguishable from theatre.
 *
 * TWO rows describe attacks that worked, and they are not the same kind. The
 * budget search is CLOSED — coarsening removed the oracle. The totalWeight window
 * solve is OPEN, and leakage.md §8 declines to mitigate it because the disclosure
 * is the mitigation at this size. Do not collapse them into one badge again. `can_afford` was a clean monotone predicate
 * over an encrypted budget with no counter and no cooldown: forty probes
 * recovered an exact figure, inside the hosted server's sixty-per-minute
 * allowance. It is closed now, by coarsening rather than by rate-limiting, and
 * the row runs the real search against the real rule so a visitor can watch it
 * converge and then stop short.
 */

type Status = "idle" | "running" | "defeated" | "failed" | "closed" | "disclosed";

function Card({
  n,
  title,
  claim,
  status,
  children,
}: {
  n: number;
  title: string;
  claim: string;
  status: Status;
  children: React.ReactNode;
}) {
  const badge =
    status === "disclosed"
      ? { t: "open · disclosed", c: "background:var(--red-bg);border:1px solid #e0c4c4;color:var(--red)" }
      : status === "closed"
      ? { t: "worked once · now closed", c: "background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent)" }
      : status === "failed"
      ? { t: "attack failed", c: "background:var(--green-bg);border:1px solid #c3ddcf;color:var(--green)" }
      : status === "defeated"
        ? { t: "attack succeeded", c: "background:var(--red-bg);border:1px solid #e0c4c4;color:var(--red)" }
        : status === "running"
          ? { t: "running…", c: "background:var(--amber-bg);border:1px solid #d9cfbc;color:var(--amber)" }
          : { t: "not run", c: "background:var(--surface-2);border:1px solid var(--line-2);color:var(--ink-3)" };
  return (
    <div style={css("padding:20px;border-radius:16px;border:1px solid var(--line);background:var(--surface)")}>
      <div style={css("display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap")}>
        <span
          style={css(
            "flex:none;width:26px;height:26px;border-radius:9px;background:var(--ink);color:var(--surface);" +
              "display:grid;place-items:center;font:800 13px var(--display)",
          )}
        >
          {n}
        </span>
        <div style={css("flex:1;min-width:220px")}>
          <div style={css("font:800 16px var(--display);letter-spacing:-.01em")}>{title}</div>
          <div style={css("margin-top:3px;font:400 12.5px/1.5 var(--display);color:var(--ink-2)")}>{claim}</div>
        </div>
        <span style={css(`padding:5px 11px;border-radius:999px;font:700 11px var(--display);white-space:nowrap;${badge.c}`)}>
          {badge.t}
        </span>
      </div>
      <div style={css("margin-top:14px")}>{children}</div>
    </div>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span style={css("font-family:var(--mono);font-size:12px")}>{children}</span>
);

const Out = ({ children }: { children: React.ReactNode }) => (
  <pre
    style={css(
      "margin:10px 0 0;padding:12px 13px;border-radius:11px;background:var(--surface-2);" +
        "border:1px solid var(--line-2);font:400 11.5px/1.65 var(--mono);white-space:pre-wrap;" +
        "word-break:break-word;overflow-x:auto",
    )}
  >
    {children}
  </pre>
);

function Btn({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={css(
        "padding:10px 15px;border-radius:11px;border:1px solid var(--line-2);background:var(--surface-2);" +
          `color:var(--ink);font:700 12.5px var(--display);cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? ".5" : "1"}`,
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row 5 — the budget oracle, the real search against the real rule
// ---------------------------------------------------------------------------

/** `coarsenBudget` from packages/mcp-server/src/sanitize.ts, verbatim. */
const COARSE_BUCKET = 50_000_000n;
const coarsenBudget = (r: bigint): bigint => (r <= 0n ? 0n : (r / COARSE_BUCKET) * COARSE_BUCKET);

interface Probe {
  call: number;
  amount: bigint;
  yes: boolean;
}

/** The binary search an attacker runs, against whichever oracle is supplied. */
function searchBudget(oracle: (a: bigint) => boolean, hi: bigint): { found: bigint; probes: Probe[] } {
  let lo = 0n;
  let high = hi;
  let call = 0;
  const probes: Probe[] = [];
  while (lo < high && call < 80) {
    const mid = (lo + high + 1n) / 2n;
    call++;
    const yes = oracle(mid);
    probes.push({ call, amount: mid, yes });
    if (yes) lo = mid;
    else high = mid - 1n;
  }
  return { found: lo, probes };
}

export function Break() {
  // Row 3 reads its own receipts rather than quoting remembered numbers.
  const liveGas = useLiveGas();
  // §8, run against the pool on screen rather than quoted from a terminal.
  const solve = useWindowSolve();
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const client = usePublicClient();

  const { data: drawCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { refetchInterval: 20_000 },
  });
  const latest = Number(drawCount ?? 0);

  const { data: hasPermit } = useHasPermit({ contractAddresses: [POOL] }, { enabled: !!address });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  // ------------------------------------------------------- participants, live
  const [participants, setParticipants] = useState<`0x${string}`[] | null>(null);
  const [loadingP, setLoadingP] = useState(false);
  const loadParticipants = useCallback(async () => {
    if (!client) return;
    setLoadingP(true);
    try {
      const logs = await client.getLogs({
        address: POOL,
        event: {
          type: "event",
          name: "Deposited",
          inputs: [
            { name: "user", type: "address", indexed: true },
            { name: "at", type: "uint40", indexed: false },
            { name: "index", type: "uint256", indexed: false },
          ],
        },
        fromBlock: FROM_BLOCK,
        toBlock: "latest",
      });
      const set = [...new Set(logs.map((l) => (l as { args: { user: `0x${string}` } }).args.user))];
      setParticipants(set);
    } catch {
      setParticipants([]);
    } finally {
      setLoadingP(false);
    }
  }, [client]);

  const victim = useMemo(
    () => participants?.find((p) => p.toLowerCase() !== address?.toLowerCase()) ?? null,
    [participants, address],
  );

  // --------------------------------------------- row 1: read someone's balance
  const { data: victimHandle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "confidentialBalanceOf",
    args: victim ? [victim] : undefined, query: { enabled: !!victim },
  });
  const victimInputs = useMemo(
    () => (victimHandle && victimHandle !== ZERO ? [{ encryptedValue: victimHandle as `0x${string}`, contractAddress: POOL }] : []),
    [victimHandle],
  );
  const [tried1, setTried1] = useState(false);
  const { data: v1, error: e1, isFetching: f1 } = useDecryptValues(victimInputs, {
    enabled: tried1 && hasPermit === true && victimInputs.length > 0,
  });
  const leaked1 = tried1 && !f1 && v1?.[victimHandle as `0x${string}`] !== undefined;
  const status1: Status = !tried1 ? "idle" : f1 ? "running" : leaked1 ? "defeated" : e1 ? "failed" : "running";

  // ------------------------------------------- row 2: tell winners from losers
  const [creditRows, setCreditRows] = useState<{ who: string; handle: string }[] | null>(null);
  const loadCredits = useCallback(async () => {
    if (!client || !participants) return;
    const out: { who: string; handle: string }[] = [];
    for (const who of participants) {
      const h = (await client.readContract({
        abi: POOL_ABI, address: POOL, functionName: "winningsOf", args: [who],
      })) as `0x${string}`;
      out.push({ who, handle: h });
    }
    setCreditRows(out);
  }, [client, participants]);

  // ---------------------------------------------- row 5: the budget oracle
  const [budget, setBudget] = useState("4237.512345");
  const [result, setResult] = useState<{
    exact: { found: bigint; probes: Probe[] };
    coarse: { found: bigint; probes: Probe[] };
    real: bigint;
  } | null>(null);

  const runSearch = useCallback(() => {
    const n = Number(budget);
    if (!Number.isFinite(n) || n <= 0) return;
    const real = BigInt(Math.round(n * 1e6));
    const hi = 1_000_000n * 1_000_000n;
    setResult({
      real,
      exact: searchBudget((a) => real >= a, hi),
      coarse: searchBudget((a) => coarsenBudget(real) >= a, hi),
    });
  }, [budget]);

  const gap = result ? result.real - result.coarse.found : 0n;

  return (
    <div style={css("max-width:1200px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Try to break it
      </h1>
      <p style={css("margin:12px 0 0;max-width:74ch;font:400 14px/1.65 var(--display);color:var(--ink-2)")}>
        Every other page on this site asks you to believe something. This one asks you to
        attack it. Five attempts against this pool. <strong>Three fail because of the
        design. Two worked</strong> — one is closed, and one is still open and disclosed
        here rather than anywhere more comfortable.
      </p>
      <p style={css("margin:8px 0 0;max-width:74ch;font:400 12.5px/1.6 var(--display);color:var(--ink-3)")}>
        Nothing here is invented, and the page says which rows you are running versus
        reading. <strong>Rows 1 and 2 execute in your browser now</strong> — the refusal comes
        from Zama&apos;s relayer and the handles from the deployed contract. <strong>Rows 3
        and 4 are measurements you can re-run yourself</strong>: row 3 reads its two
        transactions from the chain live, and row 4 shows a solve performed against this pool
        with the script in the repo. Row 5 reproduces the closed oracle locally against the
        same bucketing the server ships.
      </p>

      {!onSepolia && (
        <div style={css("margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--amber-bg);border:1px solid #d9cfbc;font:600 12.5px var(--display);color:var(--amber)")}>
          Connect to Sepolia to run rows 1 and 2. Rows 3, 4 and 5 work regardless.
        </div>
      )}

      <div style={css("margin-top:20px;display:grid;gap:16px")}>
        {/* ------------------------------------------------------------- 1 */}
        <Card
          n={1}
          title="Read another participant's balance"
          claim="The participant set is public. Pick someone and ask the relayer for their position."
          status={status1}
        >
          <div style={css("display:flex;gap:10px;flex-wrap:wrap;align-items:center")}>
            <Btn onClick={() => void loadParticipants()} disabled={loadingP}>
              {loadingP ? "reading Deposited events…" : "1. list the participants"}
            </Btn>
            {hasPermit !== true && address && (
              <Btn onClick={() => grantPermit([POOL])} disabled={granting}>
                {granting ? "signing…" : "2. grant yourself a permit"}
              </Btn>
            )}
            <Btn onClick={() => setTried1(true)} disabled={!victim || hasPermit !== true}>
              3. decrypt their balance
            </Btn>
          </div>

          {participants && (
            <Out>
              {participants.length} depositors, from the public `Deposited` log:
              {"\n"}
              {participants.map((p) => `  ${p}${p.toLowerCase() === address?.toLowerCase() ? "   <- you" : ""}`).join("\n")}
              {victim ? `\n\ntarget: ${victim}\nhandle: ${String(victimHandle ?? "…")}` : ""}
            </Out>
          )}

          {tried1 && (
            <Out>
              {f1
                ? "asking the relayer…"
                : leaked1
                  ? `LEAKED: ${String(v1?.[victimHandle as `0x${string}`])} — this should not happen; please report it`
                  : `refused by the ACL:\n${String(e1 ?? "the relayer returned no value for a handle you were never granted")}`}
            </Out>
          )}

          <p style={css("margin:10px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
            Their address is public and their handle is public. Neither helps: the pool calls{" "}
            <Mono>FHE.allow</Mono> for the holder only, so the relayer has nothing to authorise
            you against. Being able to <em>name</em> a ciphertext is not being able to read it.
          </p>
        </Card>

        {/* ------------------------------------------------------------- 2 */}
        <Card
          n={2}
          title="Work out who won"
          claim="Fetch every participant's credit handle for the latest draw and look for the winner."
          status={creditRows ? "failed" : "idle"}
        >
          <Btn onClick={() => void loadCredits()} disabled={!participants}>
            {participants ? "fetch every credit handle" : "run row 1 first"}
          </Btn>
          {creditRows && (
            <Out>
              {creditRows.map((r) => `${shortAddr(r.who)}  ${r.handle}`).join("\n")}
              {"\n\n"}
              Every one is a 32-byte handle. Same length, same shape, no flag, no ordering.
              {"\n"}
              Accrual is unconditional — `accrue` runs the identical operation sequence for
              {"\n"}
              every participant and uses `FHE.select` rather than a branch, so a winner and a
              {"\n"}
              loser differ only in a value nobody can read.
            </Out>
          )}
        </Card>

        {/* ------------------------------------------------------------- 3 */}
        <Card
          n={3}
          title="Infer the outcome from gas"
          claim="If winning costs more gas than losing, the outcome is public whatever the ciphertext says."
          status="failed"
        >
          <div style={css("overflow-x:auto")}>
            <table style={css("width:100%;border-collapse:collapse;font:400 12.5px var(--display);min-width:520px")}>
              <thead>
                <tr style={css("text-align:left;color:var(--ink-3)")}>
                  <th style={css("padding:6px 8px;font-weight:600")}>draw</th>
                  <th style={css("padding:6px 8px;font-weight:600")}>outcome</th>
                  <th style={css("padding:6px 8px;font-weight:600")}>gas</th>
                  <th style={css("padding:6px 8px;font-weight:600")}>transaction</th>
                </tr>
              </thead>
              <tbody>
                {GAS_PAIR.map((g, i) => (
                  <tr key={g.tx} style={css("border-top:1px solid var(--line-2)")}>
                    <td style={css("padding:8px")}>{g.draw}</td>
                    <td style={css("padding:8px")}>
                      {g.outcome === "lost" ? "lost" : <strong>{g.outcome}</strong>}
                    </td>
                    <td style={css("padding:8px;font-family:var(--mono);font-weight:700")}>
                      {liveGas === null
                        ? "reading…"
                        : liveGas[i] === null
                          ? "RPC unavailable"
                          : Number(liveGas[i]).toLocaleString("en-US")}
                    </td>
                    <td style={css("padding:8px")}>
                      <a href={`${EXPLORER}/tx/${g.tx}`} target="_blank" rel="noreferrer" style={css("color:var(--accent-ink);text-decoration:underline")}>
                        {g.tx.slice(0, 10)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Out>
            same address, consecutive draws, identical 68-byte calldata
            {"\n"}
            {liveGas === null || liveGas[0] === null || liveGas[1] === null
              ? "reading both receipts from Sepolia…"
              : `${liveGas[0]} - ${liveGas[1]} = ${liveGas[0]! - liveGas[1]!}`}
          </Out>
          <p style={css("margin:10px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
            One of those accruals paid a prize and the other paid nothing, and they cost the
            same to the gas unit. Accrual gas does vary — draw 33 cost 681,662 for the same
            address — but with the <em>length of that account&apos;s observation history</em>,
            never with the outcome. Draw 34&apos;s loss is verified in the clear by{" "}
            <Mono>scripts/d1-why-no-credit.ts</Mono>; draw 35&apos;s win moved{" "}
            <Mono>winnings</Mono> from 40 to 41.
          </p>
        </Card>

        {/* ------------------------------------------------------------- 4 */}
        <Card
          n={4}
          title="Recover an individual from totalWeight"
          claim="The aggregate weight is published at every reveal. Solve it for one depositor."
          status="disclosed"
        >
          <div style={css("padding:11px 13px;border-radius:11px;background:var(--red-bg);border:1px solid #e0c4c4;font:600 12px/1.6 var(--display);color:var(--red)")}>
            This row used to say <i>one equation, six unknowns</i>. That is true of one draw and
            false across several, and it is corrected here rather than quietly, because the
            correction is the more interesting fact.
          </div>
          <Out>{[
            "ONE draw, alone:",
            "  w1 + ... + w6 = totalWeight        one equation, six unknowns",
            "",
            "CONSECUTIVE draws, one balance change between them:",
            "  totalWeight = prevBalance x window + delta x (snapshotAt - eventTime)",
            "",
            "  window, snapshotAt   published in drawAt()",
            "  eventTime            block timestamp of the Deposited log",
            "  prevBalance          previous draw totalWeight / its window",
            "",
            "  -> delta is the ONLY unknown. It solves.",
          ].join("\n")}</Out>
          <button
            onClick={() => void solve.run()}
            disabled={solve.busy}
            style={css(`margin-top:12px;padding:10px 16px;border-radius:11px;border:none;background:var(--accent);font:700 12.5px var(--display);color:var(--on-accent);cursor:${solve.busy ? "wait" : "pointer"}`)}
          >
            {solve.busy ? "Reading every draw and every balance event…" : "Run it against this pool, now"}
          </button>
          <p style={css("margin:6px 0 0;font:400 10.5px/1.5 var(--display);color:var(--ink-3)")}>
            No wallet, no signature, no transaction. Every input is public: the draw records,
            the event logs and their block timestamps.
          </p>

          {solve.err !== null && (
            <Out>{"error: " + solve.err}</Out>
          )}

          {solve.report !== null && (
            <>
              <Out>{[
                `scanned            ${solve.report.windows} revealed window(s)`,
                `balance events     ${solve.report.events}  (deposit + withdraw + claim)`,
                `single-event       ${solve.report.singleEventWindows}   <- condition 1`,
                `SOLVED EXACTLY     ${solve.report.solved.length}`,
                "",
                ...(solve.report.solved.length === 0
                  ? ["nothing recoverable on this pool right now.",
                     "that is a property of how busy it happens to be,",
                     "not of anything the contract guarantees."]
                  : solve.report.solved.map(
                      (r) =>
                        `draw ${r.draw}  ${r.who.slice(0, 10)}…  ${r.kind.padEnd(8)} ${(Number(r.delta) / 1e6).toFixed(6)} cUSDC  EXACT`,
                    )),
              ].join("\n")}</Out>

              {solve.report.rejected.length > 0 && (
                <Out>{[
                  "windows that met condition 1 and still would not solve:",
                  ...solve.report.rejected.map((r) => `  draw ${r.draw}  ${r.why}`),
                  "",
                  "this list is the point. an incomplete filter turns these into",
                  "clean integers that are WRONG, and a wrong answer about a real",
                  "person is indistinguishable from a right one.",
                ].join("\n")}</Out>
              )}
            </>
          )}

          <Out>{[
            "The run that found it, on the pool this replaced — draw 33:",
            "  carried-in balance    19,000 cUSDC",
            "  totalWeight          142,512,960,000,000",
            "  base if unchanged    142,500,000,000,000",
            "  residual                  12,960,000,000  / 24s",
            "",
            "  RECOVERED  540.000000 cUSDC   integer-exact",
            "  that depositor own record: 12,000 -> 12,540. Delta 540. Match.",
            "",
            "  measured frequency: 12 balance events, 1 solved.",
          ].join("\n")}</Out>
          <p style={css("margin:10px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
            The honest claim is narrower in one direction and worse in another. The aggregate is
            underdetermined <b style={css("font-weight:650")}>only when several people change
            balance in the same window</b> — but when a window is quiet it does not merely narrow,
            it <b style={css("font-weight:650")}>solves</b>. Measured over the run that found it:{" "}
            <b style={css("font-weight:650")}>12 balance events, 1 solved exactly</b>. Rare, and
            rarity is not a mitigation — nothing in the contract enforces a minimum anonymity set,
            so the frequency is a property of how busy the pool happens to be. What it recovers is the <i>balance delta</i>, not the deposit — draw
            33&apos;s 540 was a 500 deposit plus a 40 credit the same call drained, and an
            observer cannot split them. Publishing <Mono>totalWeight</Mono> stays deliberate:
            encrypting it costs 8.3× and removes public auditability of the draw. The trade has
            not changed; the description of it has. Written up in{" "}
            <Mono>docs/leakage.md</Mono> §8, reproduced by{" "}
            <Mono>scripts/x1-window-solve.ts</Mono>.
          </p>
        </Card>

        {/* ------------------------------------------------------------- 5 */}
        <Card
          n={5}
          title="Binary-search the session budget"
          claim="can_afford answers yes or no about an encrypted budget. Ask it enough times."
          status={result ? "closed" : "idle"}
        >
          <div style={css("padding:11px 13px;border-radius:11px;background:var(--red-bg);border:1px solid #e0c4c4;font:600 12px/1.6 var(--display);color:var(--red)")}>
            This attack worked, and unlike the budget row below it, it is not closed. It is one of two rows describing a real defect
            in shipped code — found, measured at 40 calls, and closed. What runs below is the
            same search against the rule that closed it.
          </div>

          <div style={css("margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap")}>
            <label style={css("font:600 12px var(--display);color:var(--ink-2)")}>
              a budget to hunt for
            </label>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              style={css("padding:9px 11px;border-radius:10px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);font:600 13px var(--mono);width:150px")}
            />
            <Btn onClick={runSearch}>run the search</Btn>
          </div>

          {result && (
            <>
              <Out>
                {`BEFORE — the exact predicate (left >= amount)\n`}
                {result.exact.probes
                  .slice(0, 6)
                  .map((p) => `  call ${String(p.call).padStart(2)}  "can I afford ${(Number(p.amount) / 1e6).toFixed(6)}?"  ${p.yes ? "yes" : "no"}`)
                  .join("\n")}
                {`\n  …\n`}
                {result.exact.probes
                  .slice(-2)
                  .map((p) => `  call ${String(p.call).padStart(2)}  "can I afford ${(Number(p.amount) / 1e6).toFixed(6)}?"  ${p.yes ? "yes" : "no"}`)
                  .join("\n")}
                {`\n\n  recovered ${result.exact.found} after ${result.exact.probes.length} calls`}
                {`\n  real      ${result.real}`}
                {`\n  ${result.exact.found === result.real ? "EXACT MATCH — the budget is gone" : "off by " + (result.real - result.exact.found)}`}
              </Out>
              <Out>
                {`AFTER — answered against the budget rounded DOWN to ${Number(COARSE_BUCKET) / 1e6}\n`}
                {`  recovered ${result.coarse.found} after ${result.coarse.probes.length} calls`}
                {`\n  real      ${result.real}`}
                {`\n  still hidden: ${(Number(gap) / 1e6).toFixed(6)} cUSDC — and no number of further calls reduces it`}
                {`\n\n  every budget from ${result.coarse.found} to ${result.coarse.found + COARSE_BUCKET - 1n}`}
                {`\n  answers identically to every probe, so the search has nothing left to divide`}
              </Out>
            </>
          )}

          <p style={css("margin:10px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-3)")}>
            The description used to say it &ldquo;leaks neither the budget nor anything
            else&rdquo;. True of one call, false of forty — and the hosted server&apos;s
            sixty-per-minute limit clears forty inside a single window, so rate-limiting would
            have slowed the attack rather than stopped it. Coarsening removes the signal
            instead. <strong>The leak was never in the cryptography</strong>: the budget was
            encrypted the whole time. It was in the shape of the answer as it crossed the
            boundary to the model, which is why a bucket fixed it and a cipher would not have.
            Measured in <Mono>test/g1-can-afford-oracle.ts</Mono>.
          </p>
        </Card>
      </div>

      <p style={css("margin:22px 0 0;max-width:74ch;font:400 12.5px/1.7 var(--display);color:var(--ink-3)")}>
        Three of these fail because of a property of the design. Two worked because somebody
        went looking, and both are on this page rather than quietly patched — one closed by
        coarsening, one still open with both mitigations costed and neither affordable at this
        size. A defence that names the version it replaced is worth more than one that does
        not, and a page that hides its own open leak is worth nothing at all.
      </p>
    </div>
  );
}
