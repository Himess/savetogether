"use client";

import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useHasPermit } from "@zama-fhe/react-sdk";
import { CUSDC, USDC } from "../lib/addresses";
import { ERC20_ABI, ERC7984_ABI } from "../lib/abis";
import { useOnSepolia } from "../lib/chain";
import { useAction } from "../lib/tx";
import { TxStatus } from "./TxStatus";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const UNIT = 1_000_000n; // both USDC and cUSDC are 6 decimals, and the wrapper is 1:1

/**
 * The step the product was missing: turning ordinary money into confidential money.
 *
 * This is Zama's own wrapper, not ours — `0x7c5B…3639`, whose `underlying()` and
 * `rate()` were read off the chain rather than taken from a document. Wrapping is
 * where the privacy starts: your USDC balance is public and always was, and the
 * moment it becomes cUSDC the amount stops being readable by anyone but you.
 *
 * WRAPPING IS A PUBLIC ACT ON A PUBLIC AMOUNT, and the copy says so. Anyone can
 * see that this address wrapped 250 USDC. What they cannot see is anything you do
 * with it afterwards — and pretending otherwise would be the one dishonesty that
 * would matter here, because it is exactly the step where a user decides how much
 * to trust the rest.
 *
 * Three transactions, each shown rather than discovered: mint the test underlying,
 * approve the wrapper, wrap. E1 measured what a missing precondition looks like on
 * this contract — a bare `execution reverted` with nothing decodable in it — which
 * is why the preconditions are on screen instead of behind a failure.
 */
export function Wrap() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("250");
  const { writeContractAsync } = useWriteContract();
  const onSepolia = useOnSepolia();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const enabled = !!address;
  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n)) * UNIT : 0n;
  }, [amount]);

  const { data: usdc, refetch: refetchUsdc } = useReadContract({
    abi: ERC20_ABI, address: USDC, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    abi: ERC20_ABI, address: USDC, functionName: "allowance",
    args: address ? [address, CUSDC] : undefined, query: { enabled },
  });
  const { data: cHandle, refetch: refetchC } = useReadContract({
    abi: ERC7984_ABI, address: CUSDC, functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });

  const { data: hasPermit } = useHasPermit({ contractAddresses: [CUSDC] }, { enabled });
  const inputs = useMemo(
    () =>
      cHandle && cHandle !== ZERO
        ? [{ encryptedValue: cHandle as `0x${string}`, contractAddress: CUSDC }]
        : [],
    [cHandle],
  );
  const { data: clear, isFetching } = useDecryptValues(inputs, {
    enabled: enabled && hasPermit === true && inputs.length > 0,
  });

  const confidential = useMemo(() => {
    if (!cHandle || cHandle === ZERO) return "0";
    if (hasPermit !== true) return "•••";
    if (isFetching) return "reading…";
    const v = clear?.[cHandle as `0x${string}`];
    return v === undefined ? "•••" : (Number(v) / 1e6).toLocaleString();
  }, [cHandle, hasPermit, isFetching, clear]);

  if (!enabled) return null;

  const refresh = async () => {
    await refetchUsdc();
    await refetchAllowance();
    await refetchC();
  };

  const enough = (allowance ?? 0n) >= units;
  const holds = (usdc ?? 0n) >= units;

  return (
    <div className="panel">
      <h2>Wrap</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Ordinary USDC in, confidential cUSDC out, one for one, through{" "}
        <strong>Zama&apos;s own wrapper</strong>. This is where the privacy begins.
      </p>

      <table className="kv" style={{ marginBottom: 16 }}>
        <tbody>
          <tr>
            <td>USDC — public, anyone can read it</td>
            <td className="val" style={{ width: 170 }}>
              {usdc === undefined ? "…" : (Number(usdc) / 1e6).toLocaleString()}
            </td>
          </tr>
          <tr>
            <td>cUSDC — confidential, only you can</td>
            <td className="val val--big">{confidential}</td>
          </tr>
        </tbody>
      </table>

      <div className="row" style={{ marginBottom: 12 }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <span className="dim">USDC</span>
      </div>

      <table className="kv" style={{ marginBottom: 16 }}>
        <tbody>
          <tr>
            <td>Test USDC</td>
            <td style={{ width: 170 }}>
              <button
                className="ghost"
                disabled={busy || !onSepolia}
                onClick={() =>
                  void run("Minting test USDC", "1,000 USDC are in your wallet.", async () => {
                    const hash = await writeContractAsync({
                      abi: ERC20_ABI, address: USDC, functionName: "mint",
                      args: [address, 1_000n * UNIT],
                    });
                    return hash;
                  }).then(refresh)
                }
              >
                Get 1,000
              </button>
            </td>
          </tr>
          <tr>
            <td>Wrapper may take them</td>
            <td>
              {enough ? (
                <span className="val val--muted">approved</span>
              ) : (
                <button
                  className="ghost"
                  disabled={busy || !onSepolia || units === 0n}
                  onClick={() =>
                    void run("Approving", "The wrapper may take that much USDC.", async () =>
                      writeContractAsync({
                        abi: ERC20_ABI, address: USDC, functionName: "approve",
                        args: [CUSDC, units],
                      }),
                    ).then(refresh)
                  }
                >
                  Approve
                </button>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="row">
        <button
          disabled={busy || units === 0n || !enough || !holds || !onSepolia}
          onClick={() =>
            void run(
              "Wrapping",
              "That USDC is now cUSDC. From here the amounts are encrypted.",
              async () =>
                writeContractAsync({
                  abi: ERC7984_ABI, address: CUSDC, functionName: "wrap",
                  args: [address, units],
                }),
            ).then(refresh)
          }
        >
          Wrap into cUSDC
        </button>
        {!onSepolia && <span className="warn">Switch your wallet to Sepolia first.</span>}
        {onSepolia && !holds && units > 0n && (
          <span className="warn">Not that much USDC — mint some first.</span>
        )}
        {onSepolia && holds && !enough && units > 0n && (
          <span className="warn">Approve the wrapper first.</span>
        )}
      </div>

      <TxStatus state={state} />

      <p className="note">
        <strong>Wrapping is public.</strong> Anyone reading the chain can see that this
        address wrapped this much — it is an ordinary ERC-20 transfer into the wrapper.
        What they cannot see is anything you do afterwards. This is the one step in the
        whole product that is not private, and saying so is the point: everything below
        it is.
      </p>
    </div>
  );
}

export default Wrap;
