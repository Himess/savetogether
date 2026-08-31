"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useHasPermit, useEncrypt } from "@zama-fhe/react-sdk";
import { POOL, TOKEN } from "../lib/addresses";
import { ERC7984_ABI, ERC20_ABI, POOL_ABI } from "../lib/abis";
import { useOnSepolia } from "../lib/chain";
import { useAction } from "../lib/tx";
import { TxStatus } from "./TxStatus";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

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
 *
 * WHAT WAS MISSING, and it mattered more than anything else here. This panel
 * offered a faucet button and never showed the balance it filled, and every
 * action ran under a try/finally with no catch. So a wallet that failed to send
 * — cancelled, or confused about the network — produced a button that flickered
 * and went back to normal, with the error landing in the browser console where
 * nobody was looking. Someone pressed "Get 1,000", approved it, saw no change
 * anywhere on the page, and reasonably concluded the app was broken. Both halves
 * are fixed: the balance is on screen, and every action says what happened.
 */
export function Deposit() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("100");
  const { writeContractAsync } = useWriteContract();
  const { mutateAsync: encrypt, isPending: encrypting } = useEncrypt();
  const onSepolia = useOnSepolia();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const enabled = !!address && !!POOL;
  const { data: isOperator, refetch: refetchOperator } = useReadContract({
    abi: ERC7984_ABI, address: TOKEN, functionName: "isOperator",
    args: address ? [address, POOL] : undefined, query: { enabled },
  });

  // The wallet's own token balance, which the page never showed. Without it a
  // faucet button is an act of faith.
  const { data: walletHandle, refetch: refetchWallet } = useReadContract({
    abi: ERC7984_ABI, address: TOKEN, functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: hasPermit } = useHasPermit({ contractAddresses: [TOKEN] }, { enabled });
  const walletInputs = useMemo(
    () =>
      walletHandle && walletHandle !== ZERO
        ? [{ encryptedValue: walletHandle as `0x${string}`, contractAddress: TOKEN }]
        : [],
    [walletHandle],
  );
  const { data: walletClear, isFetching: readingWallet } = useDecryptValues(walletInputs, {
    enabled: enabled && hasPermit === true && walletInputs.length > 0,
  });

  const held = useMemo(() => {
    if (!walletHandle || walletHandle === ZERO) return "0";
    if (hasPermit !== true) return "•••";
    if (readingWallet) return "reading…";
    const v = walletClear?.[walletHandle as `0x${string}`];
    return v === undefined ? "•••" : String(v);
  }, [walletHandle, hasPermit, readingWallet, walletClear]);

  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n)) : 0n;
  }, [amount]);

  if (!enabled) return null;

  const after = async () => {
    await refetchOperator();
    await refetchWallet();
  };

  const mint = () =>
    void run("Getting test tokens", "1,000 gUSDC are in your wallet.", async () => {
      const hash = await writeContractAsync({
        abi: ERC20_ABI, address: TOKEN, functionName: "mint", args: [address, 1_000n],
      });
      await after();
      return hash;
    }).then(after);

  const authorise = () =>
    void run("Authorising the pool", "The pool may now move your gUSDC.", async () => {
      const hash = await writeContractAsync({
        abi: ERC7984_ABI, address: TOKEN, functionName: "setOperator",
        args: [POOL, Math.floor(Date.now() / 1000) + 365 * 24 * 3600],
      });
      await after();
      return hash;
    }).then(after);

  const deposit = () =>
    void run(
      "Depositing",
      "Your position is in the pool, encrypted. It appears above once it settles.",
      async () => {
        // encryptedValues, not handles: the SDK returns contract-ready ciphertexts
        // under that name, and reaching for the wrong one fails at runtime rather
        // than at compile time.
        const enc = await encrypt({
          contractAddress: POOL,
          userAddress: address,
          values: [{ type: "euint64", value: units }],
        });
        const hash = await writeContractAsync({
          abi: POOL_ABI, address: POOL, functionName: "deposit",
          args: [enc.encryptedValues[0] as `0x${string}`, enc.inputProof],
        });
        await after();
        return hash;
      },
    ).then(after);

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
            <td>In your wallet</td>
            <td className="val" style={{ width: 150 }}>
              {held} <span className="dim">gUSDC</span>
            </td>
          </tr>
          <tr>
            <td>Test tokens</td>
            <td>
              <button className="ghost" disabled={busy || !onSepolia} onClick={mint}>
                Get 1,000
              </button>
            </td>
          </tr>
          <tr>
            <td>Pool may move them</td>
            <td>
              {isOperator ? (
                <span className="val val--muted">authorised</span>
              ) : (
                <button className="ghost" disabled={busy || !onSepolia} onClick={authorise}>
                  Authorise
                </button>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="row">
        <button
          disabled={busy || encrypting || units === 0n || !isOperator || !onSepolia}
          onClick={deposit}
        >
          {encrypting ? "Encrypting…" : "Deposit"}
        </button>
        {!onSepolia && <span className="warn">Switch your wallet to Sepolia first.</span>}
        {onSepolia && !isOperator && <span className="warn">Authorise the pool first.</span>}
      </div>

      <TxStatus state={state} />

      <p className="note">
        The amount is encrypted in your browser before it leaves. What lands on
        chain is a ciphertext and a proof — the size of your deposit is not
        recorded anywhere in the clear, including in this transaction.
      </p>
    </div>
  );
}
