"use client";
import { useMemo } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { css } from "@/lib/css";
import { POOL } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { useAction } from "@/lib/tx";
import { TxStatus } from "@/components/TxStatus";

/**
 * The pool says "anyone may call it" five times and gave you no way to.
 *
 * `harvest`, `openDraw`, `revealDraw` and `accrueMany` carry no access control,
 * and the site leans on that repeatedly: the withdraw panel says a stalled draw is
 * "not stuck — anyone may call it", the accrual note says "if the keeper has
 * stopped, anyone may call accrue(you, N)", and the runway panel says a keeper at
 * zero leaves the pool "stalled rather than broken". All true, and all unactionable
 * — a permissionless function nobody can reach from the product is a property on
 * paper.
 *
 * It also matters when it matters most: if the keeper dies during a demo, this is
 * the difference between "the design says anyone can restart it" and restarting it.
 *
 * `revealDraw` is deliberately NOT here. It needs a KMS round trip to fetch
 * signatures before it can be sent, which is a keeper's job rather than a button —
 * and offering a button that reverts would be worse than offering none.
 */
export function Keepable({ compact = false }: { compact?: boolean }) {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const { writeContractAsync } = useWriteContract();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const { data: drawCount, refetch: refetchCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { refetchInterval: 15_000 },
  });
  const { data: minPeriod } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "minPeriod" });
  // DI. The late-draw reward, read from the chain rather than restated here. It
  // belongs on this panel and nowhere else: this is the only screen where a
  // visitor is in a position to earn it.
  const { data: livenessCap } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "LIVENESS_CAP" });
  const { data: livenessRate } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "LIVENESS_RATE_PER_SEC" });
  const round = Number(drawCount ?? 0);
  const { data: draw, refetch: refetchDraw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [round],
    query: { enabled: round > 0, refetchInterval: 15_000 },
  });

  const d = draw as unknown as { snapshotAt: bigint; status: number } | undefined;

  /** What is actually callable right now, and why not when it is not. */
  const callable = useMemo(() => {
    if (d === undefined || minPeriod === undefined) return null;
    const st = Number(d.status); // 1 = Open, 2 = Revealed
    const now = Math.floor(Date.now() / 1000);
    const earliest = Number(d.snapshotAt) + Number(minPeriod);
    if (st === 1) {
      return { can: "none" as const, why: "This draw is open and waiting on its KMS reveal. That step needs signatures fetched off chain, so it is the keeper's to send — not a button." };
    }
    if (now < earliest) {
      const wait = earliest - now;
      return { can: "harvest" as const, why: `The next draw cannot open for another ${Math.ceil(wait / 60)} minute(s) — minPeriod is a floor and the contract enforces it.` };
    }
    return { can: "open" as const, why: "The floor has passed, so the next draw can be opened by anyone. The keeper normally does this; if it has stopped, you can." };
  }, [d, minPeriod]);

  const refresh = () => { void refetchCount(); void refetchDraw(); };
  const disabled = busy || !address || !onSepolia;

  const btn = (primary: boolean) =>
    css(
      `padding:9px 14px;border-radius:11px;font:650 12px var(--display);cursor:${disabled ? "not-allowed" : "pointer"};` +
      (primary
        ? "border:none;background:var(--accent);color:var(--on-accent);"
        : "border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);") +
      `opacity:${disabled ? 0.55 : 1}`,
    );

  return (
    <div style={css(`margin-top:${compact ? 12 : 18}px;padding:13px 15px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line-2)`)}>
      <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>
        Run the pool yourself
      </span>
      <p style={css("margin:7px 0 0;font:400 11.5px/1.6 var(--display);color:var(--ink-2)")}>
        <span style={css("font-family:var(--mono);font-size:10.5px")}>harvest</span>,{" "}
        <span style={css("font-family:var(--mono);font-size:10.5px")}>openDraw</span> and{" "}
        <span style={css("font-family:var(--mono);font-size:10.5px")}>accrueMany</span> have no access control.
        The keeper is a wallet that pays gas, not a privileged role, and this page has said so in several places
        without ever giving you the buttons.
      </p>

      <div style={css("margin-top:10px;display:flex;gap:8px;flex-wrap:wrap")}>
        <button
          disabled={disabled}
          style={btn(false)}
          onClick={() =>
            void run("Harvesting", "Harvested — the reserve grew by whatever the source had earned.", async () =>
              writeContractAsync({ abi: POOL_ABI, address: POOL, functionName: "harvest" }),
            ).then(refresh)
          }
        >
          Harvest yield
        </button>
        <button
          disabled={disabled || callable?.can !== "open"}
          style={btn(callable?.can === "open")}
          onClick={() =>
            void run("Opening the next draw", "Draw opened — weights are frozen and the randomness is drawn.", async () =>
              writeContractAsync({ abi: POOL_ABI, address: POOL, functionName: "openDraw" }),
            ).then(refresh)
          }
        >
          Open the next draw
        </button>
        {address !== undefined && round > 0 && (
          <button
            disabled={disabled}
            style={btn(false)}
            onClick={() =>
              void run("Accruing", "Accrued. Winner or loser, it is the same transaction — which is the point.", async () =>
                writeContractAsync({
                  abi: POOL_ABI, address: POOL, functionName: "accrueMany", args: [[address], round],
                }),
              ).then(refresh)
            }
          >
            Settle me for round {round}
          </button>
        )}
      </div>

      {callable !== null && (
        <p style={css("margin:8px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>{callable.why}</p>
      )}
      {!address && (
        <p style={css("margin:6px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>
          Connect a wallet to send one — you pay the gas, which is the only thing the keeper was ever doing.
        </p>
      )}
      {/* Why anyone but us would send one. The schedule is plaintext on purpose:
          a bot can price this without any view onto the encrypted pot, which is
          what makes the liveness guarantee something other than a promise. */}
      {livenessCap !== undefined && livenessRate !== undefined && (
        <p style={css("margin:8px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>
          <b style={css("font-weight:650")}>Unblocking a late draw pays.</b>{" "}
          <span style={css("font-family:var(--mono)")}>{(Number(livenessRate) / 1e6).toFixed(5)} cUSDC</span>{" "}
          per second late, capped at{" "}
          <span style={css("font-family:var(--mono)")}>{(Number(livenessCap) / 1e6).toFixed(2)} cUSDC</span>{" "}
          — <span style={css("font-family:var(--mono)")}>LIVENESS_RATE_PER_SEC</span> and{" "}
          <span style={css("font-family:var(--mono)")}>LIVENESS_CAP</span>, read from the contract.
          Zero when the draw is on time, which is the common case. The schedule is public and the
          pot it comes from is encrypted, so a bot can price this without being able to see the
          reserve.
        </p>
      )}
      <TxStatus state={state} />
    </div>
  );
}
