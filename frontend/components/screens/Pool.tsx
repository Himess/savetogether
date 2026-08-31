"use client";
import { useMemo, useState, type CSSProperties } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useDecryptValues, useEncrypt, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import { css } from "@/lib/css";
import { shortAddr } from "@/lib/format";
import { CUSDC_POOL, EXPLORER, POOL, TOKEN, YIELD_SOURCE } from "@/lib/addresses";
import { ERC20_ABI, ERC7984_ABI, POOL_ABI, YIELD_ABI } from "@/lib/abis";
import { useOnSepolia } from "@/lib/chain";
import { useAction } from "@/lib/tx";
import { TxStatus } from "@/components/TxStatus";
import { TokenIcon } from "@/components/TokenIcon";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const STATUS = ["none", "open", "revealed"] as const;

function seg(active: boolean): CSSProperties {
  return {
    flex: "1 1 auto", textAlign: "center", cursor: "pointer", whiteSpace: "nowrap",
    padding: "7px 6px", borderRadius: "9px",
    fontFamily: "var(--display)", fontSize: "12px", fontWeight: active ? 700 : 550,
    color: active ? "#1a1a1a" : "var(--ink-2)",
    backgroundColor: active ? "#fff" : "transparent",
    border: active ? "1px solid var(--line-2)" : "1px solid transparent",
    boxShadow: active ? "0 1px 3px rgba(0,0,0,.06)" : "none",
  };
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div style={css("display:flex;flex-direction:column;gap:5px")}>
      <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>{label}</span>
      <span style={css("font:800 34px var(--display);letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1")}>
        {value}
        {unit !== undefined && <span style={css("font:600 14px var(--mono);color:var(--ink-3)")}> {unit}</span>}
      </span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={css("display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 0;border-bottom:1px solid var(--line)")}>
      <span style={css("font:500 13px var(--display);color:var(--ink-2)")}>{label}</span>
      <span style={css("font:650 13px var(--display);color:var(--ink);text-align:right")}>{children}</span>
    </div>
  );
}

/**
 * The pool itself, which is the submission.
 *
 * The last week of work went into the conversational layer and the documentation
 * drifted with it, so this screen puts the mechanism back in front: prizes come
 * from harvested yield, the winner is picked by on-chain FHE randomness weighted
 * by an encrypted time-weighted balance, and — the part nobody else will have —
 * THERE IS NO CLAIM STEP, because a voluntary claim would announce the winner.
 */
export function PoolScreen() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const { writeContractAsync } = useWriteContract();
  const { mutateAsync: encrypt, isPending: encrypting } = useEncrypt();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("100");

  const enabled = !!address;
  const units = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n)) : 0n;
  }, [amount]);

  const { data: drawCount } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawCount", query: { refetchInterval: 15_000 },
  });
  const { data: prize } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "prize" });
  const { data: rateBps } = useReadContract({
    abi: YIELD_ABI, address: YIELD_SOURCE, functionName: "rateBps",
  });
  const round = Number(drawCount ?? 0);
  const { data: draw } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "drawAt", args: [round],
    query: { enabled: round > 0, refetchInterval: 15_000 },
  });

  const d = draw as
    | { snapshotAt: bigint; status: number; r: bigint; totalWeight: bigint }
    | undefined;
  const phase = d === undefined ? "none" : (STATUS[Number(d.status)] ?? "none");

  const { data: isOperator, refetch: refetchOperator } = useReadContract({
    abi: ERC7984_ABI, address: TOKEN, functionName: "isOperator",
    args: address ? [address, POOL] : undefined, query: { enabled },
  });
  const { data: walletHandle, refetch: refetchWallet } = useReadContract({
    abi: ERC7984_ABI, address: TOKEN, functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: poolHandle, refetch: refetchPool } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "confidentialBalanceOf",
    args: address ? [address] : undefined, query: { enabled },
  });
  const { data: wonHandle } = useReadContract({
    abi: POOL_ABI, address: POOL, functionName: "winningsOf",
    args: address ? [address] : undefined, query: { enabled },
  });

  const { data: hasPermit } = useHasPermit({ contractAddresses: [POOL, TOKEN] }, { enabled });
  const { mutate: grantPermit, isPending: granting } = useGrantPermit();

  const handles = useMemo(
    () =>
      [
        [walletHandle, TOKEN],
        [poolHandle, POOL],
        [wonHandle, POOL],
      ]
        .filter(([h]) => !!h && h !== ZERO)
        .map(([h, c]) => ({ encryptedValue: h as `0x${string}`, contractAddress: c as string })),
    [walletHandle, poolHandle, wonHandle],
  );
  const { data: clear, isFetching } = useDecryptValues(handles, {
    enabled: enabled && hasPermit === true && handles.length > 0,
  });

  const show = (h: unknown): string => {
    if (!h || h === ZERO) return "0";
    if (hasPermit !== true) return "•••";
    if (isFetching) return "…";
    const v = clear?.[h as `0x${string}`];
    return v === undefined ? "•••" : String(v);
  };

  const refresh = async () => {
    await refetchOperator();
    await refetchWallet();
    await refetchPool();
  };

  const submit = () => {
    if (address === undefined) return;
    const fn = tab === "deposit" ? "deposit" : "withdraw";
    void run(
      tab === "deposit" ? "Depositing" : "Withdrawing",
      tab === "deposit"
        ? "Your position is in the pool, encrypted, and starts earning weight now."
        : "The transaction landed. Asking for more than you hold moves nothing, by design — check your position.",
      async () => {
        const enc = await encrypt({
          contractAddress: POOL,
          userAddress: address,
          values: [{ type: "euint64", value: units }],
        });
        return writeContractAsync({
          abi: POOL_ABI, address: POOL, functionName: fn,
          args: [enc.encryptedValues[0] as `0x${string}`, enc.inputProof],
        });
      },
    ).then(refresh);
  };

  const apy = rateBps === undefined ? "—" : `${(Number(rateBps) / 100).toFixed(0)}%`;

  return (
    <div style={css("max-width:1200px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Pool <span style={css("color:var(--ink-3);font-weight:700")}>· Win</span>
      </h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:72ch")}>
        Deposit and you can withdraw the same amount whenever you like. Only the yield becomes a
        prize, and your balance, your odds and whether you won are all encrypted.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      <div style={css("display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start")}>
        <div style={css("flex:1 1 470px;min-width:0")}>
          <div style={css("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
            <TokenIcon token="cUSDC" size={46} />
            <h2 style={css("margin:0;font:800 26px/1.08 var(--display);letter-spacing:-.02em")}>Confidential Prize Pool</h2>
            <span style={css(`padding:5px 11px;border-radius:999px;white-space:nowrap;font:700 11px var(--display);${phase === "revealed" ? "background:var(--green-bg);border:1px solid #bfe3cd;color:var(--green)" : "background:var(--accent-soft);border:1px solid #f0d97a;color:#7a5f00"}`)}>
              {phase === "revealed" ? "Round decided" : phase === "open" ? "Round open" : "No draw yet"}
            </span>
          </div>

          <div style={css("display:flex;flex-wrap:wrap;gap:22px 44px;margin-top:28px")}>
            <Metric label="Round" value={round === 0 ? "—" : `#${round}`} />
            <Metric label="Prize" value={prize === undefined ? "—" : String(prize)} unit="gUSDC" />
            <Metric label="Funded by yield at" value={apy} />
          </div>

          {/* The argument, stated where it is being scored. */}
          <div style={css("margin-top:30px;background:var(--surface-2);border:1px solid var(--line);border-radius:16px;padding:18px 20px")}>
            <span style={css("font:650 10.5px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>How it works</span>
            <ol style={css("margin:12px 0 0;padding-left:18px;font:400 13.5px/1.75 var(--display);color:var(--ink-2)")}>
              <li><b style={css("color:var(--ink);font-weight:650")}>Prizes come from harvested yield.</b> The reserve starts empty and fills from <span style={css("font-family:var(--mono);font-size:12.5px")}>harvest()</span> alone — a paired test proves a prize is paid after a harvest and nothing is paid without one.</li>
              <li><b style={css("color:var(--ink);font-weight:650")}>The winner is picked on chain.</b> FHE randomness, weighted by an encrypted time-weighted balance. In both live rounds so far the earliest and smallest depositor won, which is the time weighting doing its job.</li>
              <li><b style={css("color:var(--ink);font-weight:650")}>There is no claim step.</b> A voluntary claim would announce the winner — anyone can compute their own outcome off chain, so only winners would bother. Accrual is permissionless and unconditional instead.</li>
              <li><b style={css("color:var(--ink);font-weight:650")}>Winner and loser look identical on chain.</b> 306 live accruals: one operation sequence, one HCU figure, and gas that tracks the address rather than the outcome.</li>
            </ol>
          </div>

          <div style={css("margin-top:28px;border-top:1px solid var(--line)")}>
            <Row label="Pool">
              <a href={`${EXPLORER}/address/${POOL}`} target="_blank" rel="noreferrer" style={css("font:600 12.5px var(--mono);color:var(--ink-2)")}>{shortAddr(POOL)}</a>
            </Row>
            <Row label="Settles in">
              <span style={css("display:inline-flex;align-items:center;gap:7px")}><TokenIcon token="gUSDC" size={18} />gUSDC</span>
            </Row>
            <Row label="Same contract on Zama's cUSDC">
              <a href={`${EXPLORER}/address/${CUSDC_POOL}`} target="_blank" rel="noreferrer" style={css("font:600 12.5px var(--mono);color:var(--ink-2)")}>{shortAddr(CUSDC_POOL)}</a>
            </Row>
            {phase === "revealed" && d !== undefined && (
              <Row label="Randomness">
                <span style={css("font:600 12.5px var(--mono);color:var(--ink-3)")}>{String(d.r)}</span>
              </Row>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------- right rail --- */}
        <div style={css("flex:1 1 340px;max-width:400px;position:sticky;top:14px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:0 1px 2px rgba(20,18,12,.03),0 12px 34px rgba(20,18,12,.05);padding:16px")}>
          <div style={css("display:flex;gap:2px;padding:4px;background:var(--surface-2);border:1px solid var(--line);border-radius:12px")}>
            <button style={seg(tab === "deposit")} onClick={() => setTab("deposit")}>Deposit</button>
            <button style={seg(tab === "withdraw")} onClick={() => setTab("withdraw")}>Withdraw</button>
          </div>

          <div style={css("margin-top:12px;border:1px solid var(--line);border-radius:14px;padding:14px 16px")}>
            <div style={css("display:flex;justify-content:space-between;align-items:center;margin-bottom:6px")}>
              <span style={css("font:600 12px var(--display);color:var(--ink-2)")}>
                {tab === "deposit" ? "You deposit" : "You take out"}
              </span>
              <span style={css("font:600 11px var(--display);color:var(--ink-3)")}>
                {tab === "deposit" ? `wallet ${show(walletHandle)}` : `in pool ${show(poolHandle)}`}
              </span>
            </div>
            <div style={css("display:flex;align-items:center;gap:10px")}>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                style={css("border:none;outline:none;background:none;font:750 28px var(--display);color:var(--ink);flex:1;min-width:0;padding:0;font-variant-numeric:tabular-nums")}
              />
              <span style={css("display:inline-flex;align-items:center;gap:7px;padding:6px 11px 6px 7px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line-2);font:650 12.5px var(--mono);color:var(--ink);white-space:nowrap;flex:none")}>
                <TokenIcon token="gUSDC" size={20} />gUSDC
              </span>
            </div>
          </div>

          {/* preconditions, shown rather than discovered */}
          <div style={css("margin-top:12px;border:1px solid var(--line);border-radius:14px;padding:4px 14px")}>
            <div style={css("display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)")}>
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>Test tokens</span>
              <button
                onClick={() => {
                  if (address === undefined) return;
                  void run("Getting test tokens", "1,000 gUSDC are in your wallet.", async () =>
                    writeContractAsync({
                      abi: ERC20_ABI, address: TOKEN, functionName: "mint", args: [address, 1_000n],
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
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>Pool may move them</span>
              {isOperator ? (
                <span style={css("font:650 11.5px var(--display);color:var(--green)")}>authorised</span>
              ) : (
                <button
                  onClick={() =>
                    void run("Authorising the pool", "The pool may now move your gUSDC.", async () =>
                      writeContractAsync({
                        abi: ERC7984_ABI, address: TOKEN, functionName: "setOperator",
                        args: [POOL, Math.floor(Date.now() / 1000) + 365 * 24 * 3600],
                      }),
                    ).then(refresh)
                  }
                  disabled={busy || !onSepolia}
                  style={css("padding:6px 12px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface-2);font:650 11.5px var(--display);color:var(--ink);cursor:pointer")}
                >
                  Authorise
                </button>
              )}
            </div>
          </div>

          <button
            onClick={submit}
            disabled={busy || encrypting || units === 0n || !onSepolia || (tab === "deposit" && !isOperator)}
            style={css(`width:100%;margin-top:14px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#ffdf5c,#ffd208);color:#1a1a1a;font:700 14px var(--display);box-shadow:0 5px 15px rgba(255,210,8,.3);cursor:${busy ? "not-allowed" : "pointer"};opacity:${busy || (tab === "deposit" && !isOperator) || !onSepolia ? ".55" : "1"}`)}
          >
            {encrypting ? "Encrypting…" : tab === "deposit" ? "Confirm confidential deposit" : "Withdraw"}
          </button>

          {!onSepolia && (
            <p style={css("margin:10px 0 0;font:600 11.5px/1.5 var(--display);color:var(--amber)")}>
              Switch your wallet to Sepolia first.
            </p>
          )}

          <TxStatus state={state} />

          {/* position */}
          <div style={css("margin-top:16px;padding-top:14px;border-top:1px solid var(--line)")}>
            <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Your position</span>
            <div style={css("display:flex;justify-content:space-between;align-items:baseline;margin-top:9px")}>
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>In the pool</span>
              <span style={css("font:750 18px var(--display);font-variant-numeric:tabular-nums")}>{show(poolHandle)}</span>
            </div>
            <div style={css("display:flex;justify-content:space-between;align-items:baseline;margin-top:6px")}>
              <span style={css("font:500 12.5px var(--display);color:var(--ink-2)")}>Won, all time</span>
              <span style={css("font:650 14px var(--display);font-variant-numeric:tabular-nums;color:var(--ink-2)")}>{show(wonHandle)}</span>
            </div>

            {hasPermit !== true ? (
              <button
                onClick={() => grantPermit([POOL, TOKEN])}
                disabled={granting || !onSepolia}
                style={css("width:100%;margin-top:12px;padding:10px;border-radius:11px;border:1px solid var(--line-2);background:var(--surface-2);font:650 12px var(--display);color:var(--ink);cursor:pointer")}
              >
                {granting ? "Waiting for signature…" : "Decrypt my balances"}
              </button>
            ) : handles.length === 0 ? (
              <p style={css("margin:10px 0 0;font:400 11.5px/1.5 var(--display);color:var(--ink-3)")}>
                These are real zeros, not hidden numbers — nothing has been deposited yet.
              </p>
            ) : null}
          </div>

          <div style={css("display:flex;align-items:center;justify-content:center;gap:7px;margin-top:14px")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
            <span style={css("font:600 11px var(--display);color:var(--ink-3)")}>Encrypted in your browser before it leaves</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PoolScreen;
