"use client";
import { useReadContract, useWriteContract, useAccount } from "wagmi";
import { css } from "@/lib/css";
import { fmtUnits6 } from "@/lib/format";
import { shortAddr } from "@/lib/format";
import { CUSDC, EXPLORER, POOL, VAULT_ADAPTER, VAULT_SHARE, YIELD_SOURCE } from "@/lib/addresses";
import { POOL_ABI, VAULT_SOURCE_ABI, YIELD_ABI } from "@/lib/abis";
import { TokenIcon } from "@/components/TokenIcon";
import { useOnSepolia } from "@/lib/chain";
import { useAction } from "@/lib/tx";
import { TxStatus } from "@/components/TxStatus";

/**
 * Where the prize money comes from, and what it is honestly worth.
 *
 * TWO SOURCES, and conflating them would be the easiest lie on this whole site.
 *
 * The first is ours and it genuinely pays: `MockYieldSource` accrues
 * `principal x rate x elapsed` on the encrypted principal, `harvest()` moves it
 * into the pool's reserve, and the reserve starts EMPTY — a paired test proves a
 * prize is paid after a harvest and nothing is paid without one. The rate is
 * read off the chain rather than written into this page, and it is theatrical on
 * purpose so that a three-minute recording shows yield actually moving. The
 * screen says that in as many words.
 *
 * The second is composition: our adapter joined a real batch on Zama's deployed
 * confidential vault and holds real shares. That is worth showing and it earns
 * NOTHING — Zama's Sepolia vault is a mock, which was measured rather than
 * assumed. It is not the mainnet Steakhouse x Morpho vault and this page says so
 * where somebody deciding whether to trust the rest will actually read it.
 */
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={css("display:flex;align-items:center;justify-content:space-between;gap:16px;padding:15px 0;border-bottom:1px solid var(--line)")}>
      <span style={css("font:500 13px var(--display);color:var(--ink-2)")}>{label}</span>
      <span style={css("font:650 13px var(--display);color:var(--ink);text-align:right")}>{children}</span>
    </div>
  );
}

function Addr({ a }: { a: string }) {
  return (
    <a
      href={`${EXPLORER}/address/${a}`}
      target="_blank"
      rel="noreferrer"
      style={css("display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font:600 12px var(--mono);color:var(--ink-2);text-decoration:none")}
    >
      {shortAddr(a)}
    </a>
  );
}

export function VaultScreen() {
  const { address } = useAccount();
  const onSepolia = useOnSepolia();
  const { writeContractAsync } = useWriteContract();
  const { state, run } = useAction();
  const busy = state.phase === "wallet" || state.phase === "pending";

  const { data: rateBps } = useReadContract({
    abi: YIELD_ABI, address: YIELD_SOURCE, functionName: "rateBps",
    query: { refetchInterval: 30_000 },
  });
  const { data: prize } = useReadContract({ abi: POOL_ABI, address: POOL, functionName: "prize" });
  const { data: openBatches, refetch: refetchBatches } = useReadContract({
    abi: VAULT_SOURCE_ABI, address: YIELD_SOURCE, functionName: "openBatches",
    query: { refetchInterval: 20_000 },
  });

  const apy = rateBps === undefined ? "—" : (Number(rateBps) / 100).toFixed(0);
  const batches = (openBatches as readonly bigint[] | undefined) ?? [];

  return (
    <div style={css("max-width:1200px;width:100%")}>
      <h1 style={css("margin:0;font:800 40px/1.02 var(--display);letter-spacing:-.03em")}>
        Vault <span style={css("color:var(--ink-3);font-weight:700")}>· Earn</span>
      </h1>
      <p style={css("margin:9px 0 0;font:400 16px var(--display);color:var(--ink-2);max-width:70ch")}>
        Your principal is never at risk. Only what it earns becomes a prize — and the reserve
        that pays prizes starts empty and fills from harvested yield alone.
      </p>
      <div style={css("height:1px;background:var(--line);margin:22px 0 26px")} />

      <div style={css("display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start")}>
        <div style={css("flex:1 1 470px;min-width:0")}>
          {/* ---------------------------------------------- the engine that pays -- */}
          <div style={css("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
            <TokenIcon token="cUSDC" size={46} />
            <h2 style={css("margin:0;font:800 26px/1.08 var(--display);letter-spacing:-.02em")}>SaveTogether Yield Engine</h2>
            <span style={css("padding:5px 11px;border-radius:999px;background:var(--accent-soft);border:1px solid #f0d97a;font:700 11px var(--display);color:#7a5f00;white-space:nowrap")}>Demo rate</span>
          </div>

          <p style={css("margin:13px 0 0;font:400 14.5px/1.55 var(--display);color:var(--ink-2);max-width:62ch")}>
            Accrues <span style={css("font-family:var(--mono);font-size:13px")}>principal × rate × elapsed</span> on the
            encrypted principal, at 128 bits. <span style={css("font-weight:600;color:var(--ink)")}>harvest()</span> moves it into
            the pool&apos;s reserve, and nothing else can.
          </p>

          <div style={css("margin-top:16px;display:flex;gap:10px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--line);border-radius:14px;padding:13px 16px")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none;margin-top:1px")}><circle cx="12" cy="12" r="9"/><path d="M12 8v.5M12 11v5"/></svg>
            <p style={css("margin:0;font:400 12.5px/1.55 var(--display);color:var(--ink-3)")}>
              The rate is <b style={css("color:var(--ink-2);font-weight:600")}>deliberately theatrical</b> so a three-minute
              recording shows yield moving at all. The mechanism is real — yield is a genuine function of what the pool
              holds and for how long — only the number is loud. It is read from the contract, not typed here.
            </p>
          </div>

          <div style={css("display:flex;flex-wrap:wrap;gap:22px 44px;margin-top:28px")}>
            <Metric label="Rate" value={`${apy}%`} />
            <Metric label="Prize per draw" value={prize === undefined ? "—" : fmtUnits6(prize as bigint)} unit="cUSDC" />
            <Metric label="Reserve at start" value="0" unit="always" />
          </div>

          <div style={css("margin-top:28px;border-top:1px solid var(--line)")}>
            <DetailRow label="Engine contract"><Addr a={YIELD_SOURCE} /></DetailRow>
            <DetailRow label="Pays into"><Addr a={POOL} /></DetailRow>
            <DetailRow label="Proof that prizes come from yield">
              <span style={css("font:600 12.5px var(--display);color:var(--ink-2)")}>paired test · pays after harvest, nothing without</span>
            </DetailRow>
          </div>

          {/* ------------------------------------------------ the composition --- */}
          <div style={css("display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:44px")}>
            <TokenIcon token="csteakcUSDC" size={46} />
            <h2 style={css("margin:0;font:800 26px/1.08 var(--display);letter-spacing:-.02em")}>Zama Confidential Vault</h2>
            <span style={css("padding:5px 11px;border-radius:999px;background:#f3edff;border:1px solid #e2d5ff;font:700 11px var(--display);color:#6b41c9;white-space:nowrap")}>Composability proof</span>
          </div>

          <p style={css("margin:13px 0 0;font:400 14.5px/1.55 var(--display);color:var(--ink-2);max-width:62ch")}>
            SaveTogether&apos;s adapter joined a real batch on Zama&apos;s deployed confidential vault and holds real
            shares. A contract cannot call <span style={css("font-family:var(--mono);font-size:13px")}>join</span> — it takes an
            externally encrypted input and a proof no contract can forge — so the way in is the ERC-7984 receiver hook.
          </p>

          <div style={css("margin-top:16px;display:flex;gap:10px;align-items:flex-start;background:var(--surface-2);border:1px solid var(--line);border-radius:14px;padding:13px 16px")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none;margin-top:1px")}><circle cx="12" cy="12" r="9"/><path d="M12 8v.5M12 11v5"/></svg>
            <p style={css("margin:0;font:400 12.5px/1.55 var(--display);color:var(--ink-3)")}>
              Zama&apos;s Sepolia vault is a <b style={css("color:var(--ink-2);font-weight:600")}>mock that pays nothing</b> —
              measured, not assumed. It is <b style={css("color:var(--ink-2);font-weight:600")}>not</b> the mainnet
              Steakhouse × Morpho vault and this is not affiliated with either. What it proves is that the confidential
              layer composes; what is missing on mainnet is what a deposit can then <i>do</i>, which is the pool above.
            </p>
          </div>

          <div style={css("display:flex;flex-wrap:wrap;gap:22px 44px;margin-top:28px")}>
            <Metric label="Yield here" value="0%" />
            <Metric label="Open batches" value={String(batches.length)} />
            <Metric label="Shares" value="held" />
          </div>

          <div style={css("margin-top:28px;border-top:1px solid var(--line)")}>
            <DetailRow label="Adapter"><Addr a={VAULT_ADAPTER} /></DetailRow>
            <DetailRow label="Share token"><Addr a={VAULT_SHARE} /></DetailRow>
            <DetailRow label="Underlying"><Addr a={CUSDC} /></DetailRow>
            <DetailRow label="Chain">
              <span style={css("display:inline-flex;align-items:center;gap:7px")}>
                <span style={css("width:7px;height:7px;border-radius:50%;background:#8a63d2")} />Sepolia
              </span>
            </DetailRow>
          </div>
        </div>

        {/* ------------------------------------------------------- right rail --- */}
        <div style={css("flex:1 1 340px;max-width:400px;position:sticky;top:14px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:0 1px 2px rgba(20,18,12,.03),0 12px 34px rgba(20,18,12,.05);padding:18px")}>
          <span style={css("font:650 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Batch lifecycle</span>
          <div style={css("display:flex;align-items:center;gap:6px;margin-top:10px")}>
            <span style={css("flex:1;text-align:center;padding:7px 4px;border-radius:9px;background:var(--accent-soft);border:1px solid #f0d97a;font:700 11px var(--display);color:#7a5f00")}>Join</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none")}><path d="M9 6l6 6-6 6"/></svg>
            <span style={css("flex:1;text-align:center;padding:7px 4px;border-radius:9px;background:var(--surface-2);border:1px solid var(--line);font:600 11px var(--display);color:var(--ink-3)")}>Dispatched</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={css("flex:none")}><path d="M9 6l6 6-6 6"/></svg>
            <span style={css("flex:1;text-align:center;padding:7px 4px;border-radius:9px;background:var(--surface-2);border:1px solid var(--line);font:600 11px var(--display);color:var(--ink-3)")}>Claimed</span>
          </div>

          <p style={css("margin:14px 0 0;font:400 12.5px/1.55 var(--display);color:var(--ink-2)")}>
            Dispatch is driven by <b style={css("font-weight:600;color:var(--ink)")}>Zama&apos;s keeper</b>, not ours. Joining
            puts half the pool&apos;s principal into the next batch; the shares arrive when that batch settles. Half, because unwinding is a round trip too, so the rest stays here and withdrawals never wait on anyone else.
          </p>

          <button
            onClick={() =>
              void run(
                "Joining the vault batch",
                "The pool’s principal is in the next batch. Shares arrive when Zama's keeper dispatches it.",
                async () =>
                  writeContractAsync({
                    abi: VAULT_SOURCE_ABI, address: YIELD_SOURCE, functionName: "joinVault",
                  }),
              ).then(() => refetchBatches())
            }
            disabled={busy || !onSepolia || !address}
            style={css(`width:100%;margin-top:16px;padding:14px;border-radius:13px;border:1px solid rgba(0,0,0,.06);background:linear-gradient(180deg,#ffdf5c,#ffd208);color:#1a1a1a;font:700 14px var(--display);cursor:${busy || !onSepolia ? "not-allowed" : "pointer"};opacity:${busy || !onSepolia ? ".55" : "1"};box-shadow:0 5px 15px rgba(255,210,8,.3)`)}
          >
            Join the next batch
          </button>

          <TxStatus state={state} />

          <div style={css("display:flex;align-items:center;justify-content:center;gap:7px;margin-top:12px")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
            <span style={css("font:600 11px var(--display);color:var(--ink-3)")}>Amounts stay encrypted end to end</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VaultScreen;
