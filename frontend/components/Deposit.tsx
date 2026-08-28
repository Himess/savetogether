"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useEncrypt } from "@zama-fhe/react-sdk";
import { POOL, TOKEN } from "../lib/addresses";
import { ERC7984_ABI, ERC20_ABI, POOL_ABI } from "../lib/abis";
import { useOnSepolia } from "../lib/chain";

/**
 * Getting in.
 *
 * Three preconditions, each shown rather than discovered: you hold the token,
 * the pool is authorised to move it, and the amount is valid. E1 measured what
 * the alternative looks like — a bare `execution reverted` with no decodable
 * reason — and a judge should never meet that.
 *
 * The amount is encrypted in the browser before it is sent. The transaction
 * carries a ciphertext and a proof; the chain never sees the number, and neither
 * does anyone reading the transaction afterwards.
 */
export function Deposit() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("100");
  const { writeContractAsync } = useWriteContract();
  const { mutateAsync: encrypt, isPending: encrypting } = useEncrypt();
  const [busy, setBusy] = useState<string | null>(null);
  const onSepolia = useOnSepolia();

  const enabled = !!address && !!POOL;
  const { data: isOperator, refetch: refetchOperator } = useReadContract({
    abi: ERC7984_ABI, address: TOKEN, functionName: "isOperator",
    args: address ? [address, POOL] : undefined, query: { enabled },
  });

  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n)) : 0n;
  }, [amount]);

  if (!enabled) return null;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await refetchOperator();
    } finally {
      setBusy(null);
    }
  };

  const deposit = () =>
    run("deposit", async () => {
      // encryptedValues, not handles: the SDK returns contract-ready ciphertexts
      // under that name, and reaching for the wrong one fails at runtime rather
      // than at compile time.
      const enc = await encrypt({
        contractAddress: POOL,
        userAddress: address,
        values: [{ type: "euint64", value: units }],
      });
      await writeContractAsync({
        abi: POOL_ABI, address: POOL, functionName: "deposit",
        args: [enc.encryptedValues[0] as `0x${string}`, enc.inputProof],
      });
    });

  return (
    <div className="panel">
      <h2>Deposit</h2>

      <div className="row" style={{ marginBottom: 14 }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" />
        <span className="dim">gUSDC</span>
      </div>

      <table className="kv" style={{ marginBottom: 18 }}>
        <tbody>
          <tr>
            <td>Test tokens</td>
            <td style={{ width: 150 }}>
              <button className="ghost" disabled={!!busy || !onSepolia}
                onClick={() => run("mint", () => writeContractAsync({
                  abi: ERC20_ABI, address: TOKEN, functionName: "mint", args: [address, 1_000n],
                }))}>
                {busy === "mint" ? "…" : "Get 1,000"}
              </button>
            </td>
          </tr>
          <tr>
            <td>Pool may move them</td>
            <td>
              {isOperator ? (
                <span className="val val--muted">authorised</span>
              ) : (
                <button className="ghost" disabled={!!busy || !onSepolia}
                  onClick={() => run("operator", () => writeContractAsync({
                    abi: ERC7984_ABI, address: TOKEN, functionName: "setOperator",
                    args: [POOL, Math.floor(Date.now() / 1000) + 365 * 24 * 3600],
                  }))}>
                  {busy === "operator" ? "…" : "Authorise"}
                </button>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="row">
        <button disabled={!!busy || encrypting || units === 0n || !isOperator || !onSepolia} onClick={deposit}>
          {encrypting ? "Encrypting…" : busy === "deposit" ? "Depositing…" : "Deposit"}
        </button>
        {!onSepolia && <span className="warn">Switch your wallet to Sepolia first.</span>}
        {onSepolia && !isOperator && <span className="warn">Authorise the pool first.</span>}
      </div>

      <p className="note">
        The amount is encrypted in your browser before it leaves. What lands on
        chain is a ciphertext and a proof — the size of your deposit is not
        recorded anywhere in the clear, including in this transaction.
      </p>
    </div>
  );
}
