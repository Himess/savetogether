"use client";

import { useReadContract } from "wagmi";
import { EXPLORER, POOL } from "../lib/addresses";
import { POOL_ABI } from "../lib/abis";

const STATUS = ["not opened", "open — waiting on the reveal", "revealed"] as const;

/**
 * What the current draw is doing.
 *
 * A judge arrives mid-round like anyone else, and accrual runs in chunks of six
 * or seven participants, so there is a window in which the draw is decided but
 * not everyone has been credited yet. A screen that cannot say which state it is
 * in reads as broken rather than busy — so it names the state, and says what
 * changes when it ends.
 */
export function DrawStatus() {
  const enabled = !!POOL;
  const { data: count } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { enabled },
  });
  const { data: prize } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "prize", query: { enabled },
  });
  const id = Number(count ?? 0);
  const { data: draw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawAt",
    args: [id], query: { enabled: enabled && id > 0 },
  });

  if (!enabled) return null;

  const status = Number(draw?.status ?? 0);
  const snapshot = Number(draw?.snapshotAt ?? 0);

  return (
    <div className="panel">
      <h2>Draw</h2>
      {id === 0 ? (
        <p className="dim">No draw has been opened yet. Deposit now and you are in the first one.</p>
      ) : (
        <>
          <table className="mono" style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td className="dim">Round</td>
                <td style={{ textAlign: "right" }}>#{id}</td>
              </tr>
              <tr>
                <td className="dim">State</td>
                <td style={{ textAlign: "right" }}>{STATUS[status] ?? "unknown"}</td>
              </tr>
              <tr>
                <td className="dim">Weights frozen at</td>
                <td style={{ textAlign: "right" }}>
                  {snapshot ? new Date(snapshot * 1000).toLocaleString() : "—"}
                </td>
              </tr>
              <tr>
                <td className="dim">Prize</td>
                <td style={{ textAlign: "right" }}>{String(prize ?? 0)}</td>
              </tr>
              {status === 2 && (
                <tr>
                  <td className="dim">Randomness</td>
                  <td style={{ textAlign: "right" }}>{String(draw?.r ?? 0)}</td>
                </tr>
              )}
            </tbody>
          </table>

          {status === 1 && (
            <p className="note warn">
              The weights are frozen and the randomness has been drawn, but it is
              still encrypted. Nobody — including whoever opened the draw — knows
              the outcome until the KMS publishes it.
            </p>
          )}
          {status === 2 && (
            <p className="note">
              Decided. Credits are being applied to every participant, in chunks,
              whether they won or not. Your position updates when yours lands;
              there is nothing to press.
            </p>
          )}
        </>
      )}
      <p className="note">
        <a href={`${EXPLORER}/address/${POOL}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
          Pool on Etherscan
        </a>
      </p>
    </div>
  );
}
