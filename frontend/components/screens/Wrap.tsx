"use client";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr } from "@/lib/format";
import { CUSDC, EXPLORER, USDC } from "@/lib/addresses";
import { ERC20_ABI, ERC7984_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { useAction } from "@/lib/tx";
import { TxStatus } from "@/components/TxStatus";
import { TokenIcon } from "@/components/TokenIcon";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const UNIT = 1_000_000n; // USDC and cUSDC are both 6 decimals; the wrapper is 1:1

/**
 * Where the privacy starts, and the one step that is not private.
 *
 * Zama's own wrapper — `underlying()` and `rate()` were read off the chain rather
 * than taken from a document. Your USDC balance is public and always was; the
 * moment it becomes cUSDC the amount stops being readable by anyone but you.
 *
 * WRAPPING IS A PUBLIC ACT ON A PUBLIC AMOUNT and this screen says so twice,
 * because it is exactly where someone decides how much to trust everything
 * downstream of it. E1 measured what a missing precondition looks like on this
 * contract — a bare `execution reverted` with nothing decodable in it — so the
 * preconditions are on screen instead of behind a failure.
 */
export function WrapScreen() {
  const { address } = useAccount();
  const [amount, setAmount] = useState("250");
  const { writeContractAsync } = useWriteContract();
  const onSepolia = useOnSepolia();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const enabled = !!address;
  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
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
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  const inputs = useMemo(
    () => (cHandle && cHandle !== ZERO ? [{ encryptedValue: cHandle as `0x${string}`, contractAddress: CUSDC }] : []),
    [cHandle],
  );
  const { data: clear, isFetching } = useDecryptValues(inputs, {
    enabled: enabled && hasPermit === true && inputs.length > 0,
  });

  const confidential = useMemo(() => {
    if (!cHandle || cHandle === ZERO) return "0";
    if (hasPermit !== true) return "•••";
    if (isFetching) return "…";
    const v = clear?.[cHandle as `0x${string}`];
    return v === undefined ? "•••" : (Number(v) / 1e6).toLocaleString();
  }, [cHandle, hasPermit, isFetching, clear]);

  const refresh = async () => {
    await refetchUsdc();
    await refetchAllowance();
    await refetchC();
  };

  const approved = (allowance ?? 0n) >= units;
  const holds = (usdc ?? 0n) >= units;

  return (
    <div style={css("max-width:1200px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>Wrap</h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:72ch")}>
        Ordinary USDC in, confidential cUSDC out, one for one, through Zama&apos;s own wrapper. This is
        where the privacy begins.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      <div style={css("display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start")}>
        <div style={css("flex:1 1 470px;min-width:0")}>
          <div style={css("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
            <TokenIcon token="cUSDC" size={46} />
            <h2 style={css("margin:0;font:800 26px/1.08 var(--display);letter-spacing:-.02em")}>Confidential USDC</h2>
            <span style={css("padding:5px 11px;border-radius:999px;background:#eef4ff;border:1px solid #d5e2ff;font:700 11px var(--display);color:#2c5bbd;white-space:nowrap")}>Zama&apos;s wrapper</span>
          </div>

          <div style={css("display:flex;flex-wrap:wrap;gap:22px 44px;margin-top:28px")}>
            <div style={css("display:flex;flex-direction:column;gap:5px")}>
              <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>USDC · public</span>
              <span style={css("font:800 34px var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1")}>
                {usdc === undefined ? "—" : (Number(usdc) / 1e6).toLocaleString()}
              </span>
              <span style={css("font:500 11.5px var(--display);color:var(--amber)")}>anyone can read this</span>
            </div>
            <div style={css("display:flex;flex-direction:column;gap:5px")}>
              <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>cUSDC · confidential</span>
              <span style={css("font:800 34px var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1")}>{confidential}</span>
              <span style={css("font:500 11.5px var(--display);color:var(--green)")}>only you can</span>
            </div>
          </div>

          {hasPermit !== true && (
            <button
              onClick={() => grantPermit([CUSDC])}
              disabled={granting || !onSepolia}
              style={css("margin-top:18px;padding:9px 15px;border-radius:11px;border:1px solid var(--line-2);background:var(--surface-2);font:650 12px var(--display);color:var(--ink);cursor:pointer")}
            >
              {granting ? "Waiting for signature…" : "Decrypt my cUSDC balance"}
            </button>
          )}

          <div style={css("margin-top:26px;display:flex;gap:10px;align-items:flex-start;background:var(--accent-soft);border:1px solid #f0d97a;border-radius:14px;padding:14px 16px")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8a6d00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none;margin-top:1px")}><path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
            <p style={css("margin:0;font:400 12.5px/1.55 var(--display);color:#7a5f00")}>
              <b style={css("font-weight:700")}>Wrapping is public.</b> Anyone reading the chain can see that this address
              wrapped this much — it is an ordinary ERC-20 transfer into the wrapper. What they cannot see is anything you
              do afterwards. This is the one step in the whole product that is not private, and saying so is the point:
              everything downstream of it is.
            </p>
          </div>

          <div style={css("margin-top:28px;border-top:1px solid var(--line)")}>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:15px 0;border-bottom:1px solid var(--line)")}>
              <span style={css("font:500 13px var(--display);color:var(--ink-2)")}>Wrapper</span>
              <a href={`${EXPLORER}/address/${CUSDC}`} target="_blank" rel="noreferrer" style={css("font:600 12.5px var(--mono);color:var(--ink-2)")}>{shortAddr(CUSDC)}</a>
            </div>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:15px 0;border-bottom:1px solid var(--line)")}>
              <span style={css("font:500 13px var(--display);color:var(--ink-2)")}>Underlying</span>
              <a href={`${EXPLORER}/address/${USDC}`} target="_blank" rel="noreferrer" style={css("font:600 12.5px var(--mono);color:var(--ink-2)")}>{shortAddr(USDC)}</a>
            </div>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:15px 0;border-bottom:1px solid var(--line)")}>
              <span style={css("font:500 13px var(--display);color:var(--ink-2)")}>Rate</span>
              <span style={css("font:650 13px var(--display)")}>1 : 1 · read from the contract</span>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- right rail --- */}
        <div style={css("flex:1 1 340px;max-width:400px;position:sticky;top:14px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:0 1px 2px rgba(20,18,12,.03),0 12px 34px rgba(20,18,12,.05);padding:16px")}>
          <div style={css("border:1px solid var(--line);border-radius:14px;padding:14px 16px")}>
            <div style={css("font:600 12px var(--display);color:var(--ink-2);margin-bottom:6px")}>You wrap</div>
            <div style={css("display:flex;align-items:center;gap:10px")}>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                style={css("border:none;outline:none;background:none;font:750 28px var(--display);color:var(--ink);flex:1;min-width:0;padding:0;font-variant-numeric:tabular-nums")}
              />
              <span style={css("display:inline-flex;align-items:center;gap:7px;padding:6px 11px 6px 7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line-2);font:650 12.5px var(--mono);color:var(--ink);flex:none")}>
                <TokenIcon token="USDC" size={20} />USDC
              </span>
            </div>
          </div>
          <div style={css("display:flex;align-items:center;justify-content:space-between;padding:12px 4px 2px")}>
            <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>You receive</span>
            <span style={css("font:650 12.5px var(--mono);color:var(--ink)")}>{amount || "0"} cUSDC</span>
          </div>

          <div style={css("margin-top:12px;border:1px solid var(--line);border-radius:14px;padding:4px 14px")}>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)")}>
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>Test USDC</span>
              <button
                onClick={() => {
                  if (address === undefined) return;
                  void run("Minting test USDC", "1,000 USDC are in your wallet.", async () =>
                    writeContractAsync({
                      abi: ERC20_ABI, address: USDC, functionName: "mint", args: [address, 1_000n * UNIT],
                    }),
                  ).then(refresh);
                }}
                disabled={busy || !onSepolia || !address}
                style={css("padding:6px 12px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface-2);font:650 11.5px var(--display);color:var(--ink);cursor:pointer")}
              >
                Get 1,000
              </button>
            </div>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:10px 0")}>
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>Wrapper may take them</span>
              {approved && units > 0n ? (
                <span style={css("font:650 11.5px var(--display);color:var(--green)")}>approved</span>
              ) : (
                <button
                  onClick={() =>
                    void run("Approving", "The wrapper may take that much USDC.", async () =>
                      writeContractAsync({
                        abi: ERC20_ABI, address: USDC, functionName: "approve", args: [CUSDC, units],
                      }),
                    ).then(refresh)
                  }
                  disabled={busy || !onSepolia || units === 0n}
                  style={css("padding:6px 12px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface-2);font:650 11.5px var(--display);color:var(--ink);cursor:pointer")}
                >
                  Approve
                </button>
              )}
            </div>
          </div>

          <button
            onClick={() => {
              if (address === undefined) return;
              void run("Wrapping", "That USDC is now cUSDC. From here the amounts are encrypted.", async () =>
                writeContractAsync({
                  abi: ERC7984_ABI, address: CUSDC, functionName: "wrap", args: [address, units],
                }),
              ).then(refresh);
            }}
            disabled={busy || units === 0n || !approved || !holds || !onSepolia || !address}
            style={css(`width:100%;margin-top:14px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#ffdf5c,#ffd208);color:#1a1a1a;font:700 14px var(--display);box-shadow:0 5px 15px rgba(255,210,8,.3);cursor:pointer;opacity:${busy || units === 0n || !approved || !holds || !onSepolia ? ".55" : "1"}`)}
          >
            Wrap into cUSDC
          </button>

          {onSepolia && !holds && units > 0n && (
            <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:var(--amber)")}>
              Not that much USDC — mint some first.
            </p>
          )}

          <TxStatus state={state} />
        </div>
      </div>
    </div>
  );
}

export default WrapScreen;
