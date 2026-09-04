"use client";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useEncrypt, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr, showConfidential } from "@/lib/format";
import { CUSDC, EXPLORER, USDC } from "@/lib/addresses";
import { ERC20_ABI, ERC7984_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { useAction } from "@/lib/tx";
import { TxStatus } from "@/components/TxStatus";
import { TokenIcon } from "@/components/TokenIcon";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const UNIT = 1_000_000n; // USDC and cUSDC are both 6 decimals; the wrapper is 1:1

/**
 * An unwrap request that has been filed but has not landed.
 *
 * `unwrap` debits the cUSDC in the same transaction and then STOPS. The
 * underlying only moves when somebody calls `finalizeUnwrap` with a KMS
 * decryption proof, and that somebody is Zama's operator — the same dependency
 * the batchers have. Measured on 2026-09-03: a 100 cUSDC unwrap was still
 * unsettled eighty minutes later, with nothing on this screen to say so.
 *
 * The screen used to say the USDC "arrives when it settles" and then showed a
 * balance that had not changed, which reads as a failure rather than as a queue.
 * This keeps the request visible until the balance actually moves.
 */
type PendingUnwrap = { amount: string; at: number; hash: string; baseline: string };
const PENDING_KEY = "savetogether.pendingUnwrap.v1";

function loadPending(addr: string | undefined): PendingUnwrap | null {
  if (!addr) return null;
  try {
    const raw = window.localStorage.getItem(`${PENDING_KEY}.${addr.toLowerCase()}`);
    return raw ? (JSON.parse(raw) as PendingUnwrap) : null;
  } catch {
    return null; // private windows and blocked site data both throw here
  }
}
function savePending(addr: string, v: PendingUnwrap | null): void {
  try {
    const k = `${PENDING_KEY}.${addr.toLowerCase()}`;
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable — the panel just will not persist across a reload */
  }
}

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
  const { mutateAsync: encrypt, isPending: encrypting } = useEncrypt();
  const [amount, setAmount] = useState("250");
  const [outAmount, setOutAmount] = useState("50");
  const outUnits = useMemo(() => {
    const n = Number(outAmount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
  }, [outAmount]);
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

  // Was a hand-rolled copy of `showConfidential` with the same five states.
  // Correct, and still a second implementation that had to be kept in sync by
  // hand — which is the drift the shared helper exists to stop.
  const confidential = useMemo(
    () =>
      showConfidential({
        connected: !!address,
        handle: cHandle,
        permitted: hasPermit === true,
        fetching: isFetching,
        clear: cHandle ? clear?.[cHandle as `0x${string}`] : undefined,
      }),
    [address, cHandle, hasPermit, isFetching, clear],
  );

  /** The decrypted cUSDC balance, or null while it is hidden or absent. */
  const clearC = useMemo(() => {
    if (!cHandle || cHandle === ZERO || hasPermit !== true) return null;
    const v = clear?.[cHandle as `0x${string}`];
    if (v === undefined || v === null) return null;
    try { return BigInt(v as string | number | bigint); } catch { return null; }
  }, [cHandle, hasPermit, clear]);

  const refresh = async () => {
    await refetchUsdc();
    await refetchAllowance();
    await refetchC();
  };

  // ---------------------------------------------------------- pending unwrap
  const [pending, setPending] = useState<PendingUnwrap | null>(null);
  useEffect(() => setPending(loadPending(address)), [address]);

  // The request is settled when the public USDC balance has risen by at least
  // what was asked for. Comparing against the balance recorded at request time
  // rather than against a delta keeps this correct across reloads.
  useEffect(() => {
    if (!pending || !address || usdc === undefined) return;
    if (usdc - BigInt(pending.baseline) >= BigInt(pending.amount)) {
      savePending(address, null);
      setPending(null);
    }
  }, [pending, address, usdc]);

  // Nothing tells the page when the operator finalises, so it has to look.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refetchUsdc(), 20_000);
    return () => clearInterval(t);
  }, [pending, refetchUsdc]);

  const waitedMin = pending ? Math.max(0, Math.round((Date.now() - pending.at) / 60_000)) : 0;

  /**
   * W9. Why unwrapping is unavailable, said rather than implied.
   *
   * The wrap half of this screen already gated on its preconditions and showed
   * the reason; this half was fully enabled against a balance of zero. Same
   * screen, same class of bug as the Pool tabs disagreeing.
   */
  const unwrapBlocked: string | null = useMemo(() => {
    if (!address) return "Connect a wallet to unwrap.";
    if (!onSepolia) return "Switch your wallet to Sepolia first.";
    if (outUnits === 0n) return "Enter an amount above zero.";
    if (cHandle === ZERO) return "You hold no cUSDC yet — wrap some above first.";
    if (hasPermit !== true) return "Decrypt your balance first, so you can see what you are unwrapping.";
    const v = cHandle ? clear?.[cHandle as `0x${string}`] : undefined;
    if (v !== undefined && outUnits > BigInt(v as string | number | bigint)) {
      return "That is more cUSDC than you hold. ERC-7984 clamps rather than reverting, so this would succeed and move nothing.";
    }
    return null;
  }, [address, onSepolia, outUnits, cHandle, hasPermit, clear]);

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
              <span style={css("font:500 11.5px var(--display);color:var(--green)")}>
                {cHandle === undefined || cHandle === ZERO ? "a real zero — nothing to decrypt" : "only you can"}
              </span>
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

          {/* R6. This was an amber panel with a warning triangle, which told a
              first-time visitor something was wrong at the exact moment we were
              being straight with them. Wrapping being public is not a hazard; it
              is a fact, and stating it is the most honest sentence on the screen.
              Neutral information styling, and an info glyph rather than a
              warning one. */}
          <div style={css("margin-top:26px;display:flex;gap:10px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--line-2);border-radius:14px;padding:14px 16px")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none;margin-top:1px")}><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.6"/></svg>
            <p style={css("margin:0;font:400 12.5px/1.55 var(--display);color:var(--ink-2)")}>
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
              {/* MAX. The public USDC balance is already on screen above; making
                  somebody read it and retype it was work the page could do. Only
                  offered when there is a balance to take — a MAX that fills in
                  zero is a button that lies about being useful. */}
              {usdc !== undefined && (usdc as bigint) > 0n && (
                <button
                  onClick={() => setAmount((Number(usdc as bigint) / 1e6).toString())}
                  style={css("padding:5px 10px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface-2);font:650 11px var(--display);color:var(--ink-2);cursor:pointer;flex:none")}
                >
                  MAX
                </button>
              )}
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
            {/* Say it once, at the top, instead of leaving three dead buttons to be
                discovered by pressing them. The unwrap panel already said "Switch
                your wallet to Sepolia first" — but it is 400px lower, so somebody
                pressing Get 1,000 never saw it. */}
            {address !== undefined && !onSepolia && (
              <div style={css("margin:2px 0 8px;padding:9px 11px;border-radius:10px;background:var(--red-bg);border:1px solid #e0c4c4;font:600 11.5px/1.55 var(--display);color:var(--red)")}>
                Your wallet is not on Sepolia, so every button in this panel is disabled. There is a{" "}
                <b style={css("font-weight:750")}>Switch to Sepolia</b> button in the sidebar.
              </div>
            )}
            {address === undefined && (
              <div style={css("margin:2px 0 8px;padding:9px 11px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line-2);font:500 11.5px/1.55 var(--display);color:var(--ink-2)")}>
                Connect a wallet to use this panel.
              </div>
            )}
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
            style={css(`width:100%;margin-top:14px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#24507d,#1b3a5c);color:var(--on-accent);font:700 14px var(--display);box-shadow:0 5px 15px rgba(27,58,92,.28);cursor:pointer;opacity:${busy || units === 0n || !approved || !holds || !onSepolia ? ".55" : "1"}`)}
          >
            Wrap into cUSDC
          </button>

          {onSepolia && !holds && units > 0n && (
            <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:var(--amber)")}>
              Not that much USDC — mint some first.
            </p>
          )}

          <TxStatus state={state} />

          {/* ------------------------------------------------------- unwrap --
              The way back, which the site did not have. A judge could put money
              in and could not take it all the way out to a public token, so the
              round trip that demonstrates "no loss" — withdraw, unwrap, hold
              ordinary USDC — stopped one step short.

              It is deliberately NOT a session tool: unwrapping publishes the
              amount, which is a disclosure decision, and a model must not make
              one on someone's behalf. Here it is the user's own wallet and their
              own choice, which is the only place that decision belongs. */}
          <div style={css("margin-top:26px;padding-top:20px;border-top:1px solid var(--line)")}>
            <div style={css("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
              <span style={css("font:700 15px var(--display)")}>Go back to public USDC</span>
              <span style={css("padding:4px 10px;border-radius:999px;background:var(--amber-bg);border:1px solid #d9cfbc;font:700 10.5px var(--display);color:var(--amber);white-space:nowrap")}>
                publishes the amount
              </span>
            </div>

            <p style={css("margin:9px 0 0;font:400 12.5px/1.6 var(--display);color:var(--ink-2)")}>
              Unwrapping is the one action here that <b style={css("font-weight:650")}>reveals a number</b>. Zama&apos;s
              wrapper decrypts the amount through the KMS and emits it in the clear, because ordinary
              USDC cannot hold a secret. Everything you did in between stays private — what becomes
              public is only how much came back out, and when.
            </p>

            <div style={css("margin-top:14px;border:1px solid var(--line);border-radius:14px;padding:14px 16px")}>
              <div style={css("display:flex;justify-content:space-between;align-items:center;margin-bottom:6px")}>
                <span style={css("font:600 12px var(--display);color:var(--ink-2)")}>You unwrap</span>
                <span style={css("font:600 11px var(--display);color:var(--ink-3)")}>cUSDC {confidential}</span>
              </div>
              <div style={css("display:flex;align-items:center;gap:10px")}>
                <input
                  value={outAmount}
                  onChange={(e) => setOutAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  style={css("border:none;outline:none;background:none;font:750 28px var(--display);color:var(--ink);flex:1;min-width:0;padding:0;font-variant-numeric:tabular-nums")}
                />
                {/* MAX here needs the DECRYPTED balance, which only exists once a
                    permit has been signed. Offering it against a hidden figure would
                    mean filling in a number the page cannot read, so it appears with
                    the number and not before. */}
                {clearC !== null && clearC > 0n && (
                  <button
                    onClick={() => setOutAmount((Number(clearC) / 1e6).toString())}
                    style={css("padding:5px 10px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface-2);font:650 11px var(--display);color:var(--ink-2);cursor:pointer;flex:none")}
                  >
                    MAX
                  </button>
                )}
                <span style={css("display:inline-flex;align-items:center;gap:7px;padding:6px 11px 6px 7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line-2);font:650 12.5px var(--mono);color:var(--ink);white-space:nowrap;flex:none")}>
                  <TokenIcon token="USDC" size={20} />USDC
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                if (address === undefined) return;
                void run(
                  "Unwrapping",
                  "Requested. Zama's KMS decrypts the amount and the underlying USDC arrives when it settles — that figure is public from now on, and nothing before it is.",
                  async () => {
                    const enc = await encrypt({
                      contractAddress: CUSDC,
                      userAddress: address,
                      values: [{ type: "euint64", value: outUnits }],
                    });
                    const hash = await writeContractAsync({
                      abi: ERC7984_ABI,
                      address: CUSDC,
                      functionName: "unwrap",
                      args: [address, address, enc.encryptedValues[0] as `0x${string}`, enc.inputProof],
                    });
                    // Record it before the refresh: the cUSDC is gone from this
                    // point and the USDC has not arrived, and that gap is the
                    // whole reason this panel exists.
                    const p: PendingUnwrap = {
                      amount: outUnits.toString(),
                      at: Date.now(),
                      hash,
                      baseline: (usdc ?? 0n).toString(),
                    };
                    savePending(address, p);
                    setPending(p);
                    return hash;
                  },
                ).then(refresh);
              }}
              disabled={unwrapBlocked !== null || busy || encrypting}
              style={css(`width:100%;margin-top:14px;padding:13px;border-radius:13px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);font:700 13.5px var(--display);cursor:pointer;opacity:${busy || outUnits === 0n || !onSepolia ? ".55" : "1"}`)}
            >
              {encrypting ? "Encrypting…" : "Unwrap to public USDC"}
            </button>

            {/* W9. The wrap half was gated with its reason shown and this half was
                not — fully enabled against a balance of zero, on the same screen. */}
            {unwrapBlocked !== null && !busy && !encrypting && (
              <p style={css("margin:9px 0 0;font:600 11.5px/1.5 var(--display);color:var(--amber)")}>
                {unwrapBlocked}
              </p>
            )}

            {/* The queue, made visible. Without this the screen debits the cUSDC,
                promises USDC "when it settles", and then shows an unchanged
                balance for an hour — which reads as a failure rather than a
                wait. Settlement is `finalizeUnwrap` with a KMS proof, sent by
                Zama's operator, and no ETA is knowable from here. */}
            {pending && (
              <div style={css("margin-top:14px;padding:13px 14px;border-radius:13px;border:1px solid #d9cfbc;background:var(--amber-bg)")}>
                <div style={css("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
                  <span style={css("width:8px;height:8px;border-radius:999px;background:#c99a2e;flex:none")} />
                  <span style={css("font:700 12.5px var(--display);color:var(--amber)")}>
                    Unwrap filed — {(Number(pending.amount) / 1e6).toLocaleString()} cUSDC
                  </span>
                  <span style={css("font:400 11px var(--display);color:var(--amber)")}>
                    waiting {waitedMin < 1 ? "under a minute" : `${waitedMin} min`}
                  </span>
                </div>
                <p style={css("margin:8px 0 0;font:400 11px/1.6 var(--display);color:var(--amber)")}>
                  Your cUSDC is already debited. The USDC has not arrived yet, and that is
                  expected: <span style={css("font-family:var(--mono)")}>unwrap</span> only files
                  the request. The underlying moves when someone calls{" "}
                  <span style={css("font-family:var(--mono)")}>finalizeUnwrap</span> with a KMS
                  decryption proof — in practice Zama&apos;s operator, on no fixed schedule.
                  Nothing is lost while you wait, and this panel clears itself when the balance
                  moves.
                </p>
                <div style={css("margin-top:8px;display:flex;gap:12px;flex-wrap:wrap")}>
                  <a
                    href={`${EXPLORER}/tx/${pending.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    style={css("font:600 11px var(--display);color:var(--amber);text-decoration:underline")}
                  >
                    the request →
                  </a>
                  <button
                    onClick={() => {
                      if (!address) return;
                      savePending(address, null);
                      setPending(null);
                    }}
                    style={css("border:0;background:none;padding:0;font:600 11px var(--display);color:var(--amber);cursor:pointer;text-decoration:underline")}
                  >
                    dismiss
                  </button>
                </div>
              </div>
            )}

            <p style={css("margin:10px 0 0;font:400 11px/1.55 var(--display);color:var(--ink-3)")}>
              Asynchronous by design — the request goes in, the KMS decrypts, and the USDC lands
              when it settles. A chat session can do this too, but its ceiling is enforced by the
              server rather than by the on-chain budget: the wrapper only accepts an encrypted
              amount, and no contract can produce one on your behalf.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WrapScreen;
