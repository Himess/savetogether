"use client";

import { useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { POOL } from "../lib/addresses";
import { POOL_ABI } from "../lib/abis";
import { useEncrypt } from "@zama-fhe/react-sdk";

/**
 * Taking money out.
 *
 * The product's claim is no-loss, so this has to be as visible and as easy as
 * depositing — a savings pool you cannot demonstrably leave is not a savings
 * pool.
 *
 * Asking for more than the balance does not fail. The contract clamps the
 * request to an encrypted zero and the transaction succeeds having moved
 * nothing, because a revert would be visible on chain and "this account tried to
 * take out more than it had" is exactly the kind of fact the pool exists to keep
 * private. The copy says so, since a user who sees a successful transaction move
 * nothing deserves to know why.
 */
export function Withdraw() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("50");
  const { writeContractAsync } = useWriteContract();
  const { mutateAsync: encrypt, isPending: encrypting } = useEncrypt();
  const [busy, setBusy] = useState(false);

  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
  }, [amount]);

  if (!address || !POOL) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const enc = await encrypt({
        contractAddress: POOL,
        userAddress: address,
        values: [{ type: "euint64", value: units }],
      });
      await writeContractAsync({
        abi: POOL_ABI, address: POOL, functionName: "withdraw",
        args: [enc.encryptedValues[0] as `0x${string}`, enc.inputProof],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Withdraw</h2>
      <div className="row">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <span className="dim">cUSDC</span>
        <button disabled={busy || encrypting || units === 0n} onClick={submit}>
          {encrypting ? "Encrypting…" : busy ? "Sending…" : "Withdraw"}
        </button>
      </div>
      <p className="note">
        Your principal is never at risk — only the yield funds prizes. Asking for
        more than you hold succeeds and moves nothing, on purpose: a failed
        transaction would be visible, and what you tried to withdraw is nobody
        else&apos;s business.
      </p>
    </div>
  );
}
