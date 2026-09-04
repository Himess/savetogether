"use client";
import { useEffect } from "react";
import { useReadContract } from "wagmi";
import { useDecryptPublicValues } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { POOL } from "@/lib/addresses";
import { POOL_ABI } from "@/lib/abis";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Can this draw pay its headline prize?
 *
 * The contract answers, and until now nothing asked. `openDraw` derives one bit —
 * does the reserve cover SOLVENCY_COVER grand prizes — marks it publicly
 * decryptable, and stores it per draw. It shipped with the CD redeploy, has a
 * transaction behind it in `rubric.md` §5, and appeared on no screen: a feature
 * whose entire purpose is "the pool's central promise becomes checkable by
 * someone who does not trust the operator", checkable by nobody.
 *
 * NO WALLET, NO PERMIT, NO TRANSACTION. `useDecryptPublicValues` uses the network
 * public key, so this renders for a visitor who has connected nothing — which is
 * the only way a promise-checking control is worth anything.
 *
 * It is one bit about the POOL and never about a participant. It says whether a
 * prize can be paid; it says nothing about who might receive one.
 */
export function Solvency({ drawId }: { drawId: number }) {
  // CU. Read from the contract, not typed in here. `SOLVENCY_COVER` is what "can
  // pay its grand prize" actually MEANS, so a stale copy would have this panel
  // state a threshold the chain does not use.
  const { data: coverRaw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "SOLVENCY_COVER",
  });
  const { data: grandRaw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "tierPrize", args: [0n],
  });
  const cover = coverRaw === undefined ? null : Number(coverRaw);
  const grand = grandRaw === undefined ? null : Number(grandRaw) / 1e6;
  const { data: handle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "solventAt",
    args: [drawId], query: { enabled: drawId > 0 },
  });

  const decrypt = useDecryptPublicValues();
  const h = handle as `0x${string}` | undefined;

  useEffect(() => {
    if (h && h !== ZERO) decrypt.mutate([h]);
    // `decrypt` is a mutation object and is not stable across renders; including
    // it re-fires the request forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h]);

  if (drawId <= 0) return null;

  const raw = h && h !== ZERO ? decrypt.data?.clearValues?.[h] : undefined;
  const state: "reading" | "yes" | "no" | "none" =
    h === undefined ? "reading"
      : h === ZERO ? "none"
        : raw === undefined ? "reading"
          : raw === true || raw === 1n || raw === 1 ? "yes" : "no";

  if (state === "none") return null;

  const tone = state === "yes" ? "var(--green)" : state === "no" ? "var(--amber)" : "var(--ink-3)";
  const bg = state === "yes" ? "var(--green-bg)" : state === "no" ? "var(--amber-bg)" : "var(--surface-2)";

  return (
    <div style={css(`margin-top:12px;padding:11px 13px;border-radius:11px;background:${bg};border:1px solid var(--line-2)`)}>
      <div style={css("display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap")}>
        <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>
          Can draw #{drawId} pay its grand prize?
        </span>
        <span style={css(`font:750 13px var(--display);color:${tone}`)}>
          {state === "reading" ? "reading the chain…" : state === "yes" ? "yes" : "not yet"}
        </span>
      </div>
      <p style={css("margin:7px 0 0;font:400 10.5px/1.55 var(--display);color:var(--ink-3)")}>
        {state === "no" ? (
          <>
            The reserve does not yet cover <b style={css("font-weight:650")}>{cover ?? "…"} × {grand ?? "…"} cUSDC</b>. A
            cleared threshold against a short reserve credits <b style={css("font-weight:650")}>zero</b>, and on
            chain that is indistinguishable from losing — so this is the one warning the design cannot give you
            after the fact. It fills from <span style={css("font-family:var(--mono);font-size:10px")}>harvest()</span>{" "}
            alone, so it is a matter of rounds, not of anyone deciding.
          </>
        ) : (
          <>
            The reserve covered <b style={css("font-weight:650")}>{cover ?? "…"} × {grand ?? "…"} cUSDC</b> when this
            draw opened — {cover ?? "several"} grand prizes rather than one, because a draw can produce several
            winners and covering a single prize leaves nothing for the second.
          </>
        )}{" "}
        Computed on chain as an encrypted comparison and published as one bit.
        <b style={css("font-weight:650")}> It is not a guarantee that you will be paid.</b> It says what the
        reserve held <i>at the moment the draw opened</i>, about the pool and never about a participant —
        whether a prize <i>can</i> be paid, not whether one is owed to you or will land. Verify&apos;s tier table
        makes the matching distinction between clearing a threshold and being credited. No wallet and no
        signature: the network public key decrypts it, so anyone can check this.
      </p>
    </div>
  );
}
