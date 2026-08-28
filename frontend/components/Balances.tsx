"use client";

import { useMemo } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { POOL } from "../lib/addresses";
import { POOL_ABI } from "../lib/abis";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Balance, winnings and any credit still to be folded in — all encrypted on
 * chain, decrypted locally behind one EIP-712 signature.
 *
 * The decryption is the bounty's stated requirement, but it is also the honest
 * shape of the product: these values are not hidden from the owner, they are
 * hidden from everyone else. One permit covers every handle this contract holds
 * for the caller, so the signature is asked for once rather than per value.
 *
 * `pending` is shown rather than folded into the displayed balance, because they
 * are different facts: pending is won and recorded, balance is what is earning
 * weight in the next draw. Hiding the distinction would misstate the odds.
 */
export function Balances() {
  const { address } = useAccount();
  const enabled = !!address && !!POOL;

  const { data: balanceHandle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: winHandle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "winningsOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: pendHandle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "pendingOf",
    args: address ? [address] : undefined, query: { enabled },
  });

  const { data: hasPermit } = useHasPermit({ contractAddresses: [POOL] }, { enabled });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  const handles = useMemo(
    () => [balanceHandle, winHandle, pendHandle].filter((h): h is `0x${string}` => !!h && h !== ZERO),
    [balanceHandle, winHandle, pendHandle],
  );
  const inputs = useMemo(
    () => handles.map((h) => ({ encryptedValue: h, contractAddress: POOL })),
    [handles],
  );
  const { data: clear, isFetching } = useDecryptValues(inputs, {
    enabled: enabled && hasPermit === true && inputs.length > 0,
  });

  const show = (h: unknown) => {
    if (!h || h === ZERO) return "0";
    if (!hasPermit) return "•••";
    if (isFetching) return "decrypting…";
    const v = clear?.[h as `0x${string}`];
    return v === undefined ? "•••" : String(v);
  };

  if (!enabled) return null;

  return (
    <div className="panel">
      <h2>Your position</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>In the pool</td>
            <td className="val val--big">{show(balanceHandle)}</td>
          </tr>
          <tr>
            <td>Won, all time</td>
            <td className="val">{show(winHandle)}</td>
          </tr>
          <tr>
            <td>Won, not yet compounded</td>
            <td className="val val--muted">{show(pendHandle)}</td>
          </tr>
        </tbody>
      </table>

      {hasPermit !== true && (
        <div className="row" style={{ marginTop: 14 }}>
          <button disabled={granting} onClick={() => grantPermit([POOL])}>
            {granting ? "Waiting for signature…" : "Decrypt my balances"}
          </button>
          <span className="dim">One EIP-712 signature, kept in this browser.</span>
        </div>
      )}

      <p className="note">
        These live encrypted on chain. Nobody — not the pool, not the keeper, not
        another depositor — can read them. Anything won is credited automatically;
        there is no prize to claim, which is deliberate: if claiming were optional,
        only winners would do it and <strong>claiming would announce the winner</strong>.
      </p>
    </div>
  );
}
