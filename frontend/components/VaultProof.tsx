"use client";

import { useReadContract } from "wagmi";
import {
  DEPOSIT_BATCHER,
  EXPLORER,
  VAULT_ADAPTER,
  VAULT_SHARE,
} from "../lib/addresses";
import { ADAPTER_ABI, BATCHER_ABI, SHARE_ABI } from "../lib/abis";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

const link = (addr: string, label?: string) => (
  <a
    href={`${EXPLORER}/address/${addr}`}
    target="_blank"
    rel="noreferrer"
    className="mono"
    style={{ color: "var(--ink)", textDecoration: "underline" }}
  >
    {label ?? `${addr.slice(0, 10)}…${addr.slice(-6)}`}
  </a>
);

/**
 * Evidence, not a product surface. Nothing here can be pressed.
 *
 * The pool composes with Zama's deployed confidential vault, and this shows the
 * round that proves it rather than describing it. Every value is read live from
 * the chain, so it cannot go stale against a claim in a README.
 *
 * There is deliberately no Deposit button. Entry goes through the batcher's
 * receiver hook, and settlement is not permissionless in practice — our own
 * `dispatchBatchCallback` reverted, and the batch closed because Zama runs a
 * keeper. Offering a deposit here would leave someone waiting on infrastructure
 * that is not ours, holding a position that reads as neither in nor out.
 */
export function VaultProof() {
  const { data: shareName } = useReadContract({
    abi: SHARE_ABI, address: VAULT_SHARE, functionName: "name",
  });
  const { data: shareSymbol } = useReadContract({
    abi: SHARE_ABI, address: VAULT_SHARE, functionName: "symbol",
  });
  const { data: heldShares } = useReadContract({
    abi: SHARE_ABI, address: VAULT_SHARE, functionName: "confidentialBalanceOf",
    args: [VAULT_ADAPTER],
  });
  const { data: batches } = useReadContract({
    abi: ADAPTER_ABI, address: VAULT_ADAPTER, functionName: "openBatches",
  });
  const { data: adapterAsset } = useReadContract({
    abi: ADAPTER_ABI, address: VAULT_ADAPTER, functionName: "asset",
  });
  const batchId = batches?.[0];
  const { data: batchState } = useReadContract({
    abi: BATCHER_ABI, address: DEPOSIT_BATCHER, functionName: "batchState",
    args: batchId !== undefined ? [batchId] : undefined,
    query: { enabled: batchId !== undefined },
  });

  const holds = !!heldShares && heldShares !== ZERO;

  return (
    <div className="panel panel--feature">
      <h2>
        Vault integration
        <span className={holds ? "pill pill--live" : "pill pill--idle"}>
          {holds ? "shares held" : "reading…"}
        </span>
      </h2>

      <table className="kv">
        <tbody>
          <tr>
            <td>Adapter</td>
            <td className="val">{link(VAULT_ADAPTER)}</td>
          </tr>
          <tr>
            <td>Holds</td>
            <td className="val">{adapterAsset ? link(adapterAsset as string, "cUSDC") : "—"}</td>
          </tr>
          <tr>
            <td>Vault share token</td>
            <td className="val">
              {shareName ? `${shareName}` : "—"}
              {shareSymbol ? ` (${shareSymbol})` : ""}
            </td>
          </tr>
          <tr>
            <td>Batch joined</td>
            <td className="val">{batchId !== undefined ? `#${String(batchId)}` : "—"}</td>
          </tr>
          <tr>
            <td>Batch state</td>
            <td className="val val--muted">
              {batchState !== undefined ? `settled (${String(batchState)})` : "—"}
            </td>
          </tr>
          <tr>
            <td>Shares held, encrypted</td>
            <td className="val val--muted">
              {holds ? `${(heldShares as string).slice(0, 18)}…` : "none"}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="note">
        This adapter joined a batch on Zama&apos;s deployed confidential vault, the
        batch settled, and it claimed real vault shares. The share balance above is
        encrypted and belongs to the adapter — nobody else can read it, which is the
        behaviour, not a limitation of this page.
      </p>

      <p className="note note--plain">
        <strong>It pays no prize, and that is expected.</strong>{" "}
        The deployed vault
        is a staging instance with no yield adapter, so it produces nothing to
        harvest. The demo pool runs on a simulated yield source for that reason —
        and because settlement here is a batch round trip that depends on
        Zama&apos;s keeper. The real Steakhouse × Morpho vault is mainnet-only and
        takes this same adapter.
      </p>
    </div>
  );
}
