"use client";
import { CSSProperties, ReactNode, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { css } from "@/lib/css";
import { SEPOLIA_CHAIN_ID } from "@/lib/addresses";
import { useNav, type Route } from "@/lib/nav";
import { shortAddr } from "@/lib/format";
import { useToast } from "@/components/Toast";

function navStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: "11px", width: "100%",
    padding: "9px 12px", borderRadius: "12px", cursor: "pointer",
    fontFamily: "var(--display)", fontSize: "14.5px", fontWeight: active ? 650 : 500,
    letterSpacing: "-0.01em", textAlign: "left", whiteSpace: "nowrap",
    // AF. When yellow was the accent, a solid block here cost nothing: yellow was
    // decoration and the eye did not read it as an instruction. Navy is not
    // decoration — it now means "this is the action" — so a solid navy nav item
    //competed with the deposit button for the same signal, and on the Pool
    // screen the two were the same size.
    //
    // The solid fill is reserved for actions. Being on a page is stated with
    // navy text on a tint, which is louder than the inactive items and quieter
    // than anything you can press.
    color: active ? "var(--accent-ink)" : "var(--ink-2)",
    backgroundColor: active ? "var(--accent-soft)" : "transparent",
    backgroundImage: "none",
    border: active ? "1px solid var(--accent-line)" : "1px solid transparent",
    boxShadow: "none",
  };
}

const ICON: Record<Route, ReactNode> = {
  pool: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 16.5c1.6 0 1.6-1.4 3.2-1.4s1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4"/><path d="M3 20.5c1.6 0 1.6-1.4 3.2-1.4s1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4"/><path d="M12 3.5l1.7 3.6 3.9.5-2.8 2.7.7 3.9L12 12.3l-3.5 1.9.7-3.9-2.8-2.7 3.9-.5z"/></svg>),
  wrap: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="9" width="16" height="11" rx="2.5"/><path d="M8 9V6.5a4 4 0 0 1 8 0V9"/><circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></svg>),
  vault: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6.4" rx="7.3" ry="3.1"/><path d="M4.7 6.4v5.4c0 1.7 3.3 3.1 7.3 3.1s7.3-1.4 7.3-3.1V6.4"/><path d="M4.7 11.8v5.4c0 1.7 3.3 3.1 7.3 3.1s7.3-1.4 7.3-3.1v-5.4"/></svg>),
  chat: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 12c0 4.3-3.8 7.7-8.5 7.7-1.1 0-2.2-.2-3.2-.5L3.5 21l1.4-4.1A7.3 7.3 0 0 1 3.5 12c0-4.3 3.8-7.7 8.5-7.7s8.5 3.4 8.5 7.7Z"/><path d="M8.5 11.5h7M8.5 14.5h4"/></svg>),
  verify: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2l7.2 2.7v5.4c0 4.4-3 8.3-7.2 9.5-4.2-1.2-7.2-5.1-7.2-9.5V5.9Z"/><path d="M9 12.2l2.1 2.1L15.4 10"/></svg>),
  position: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 19h18"/><path d="M5 19v-6M10 19V7M15 19v-9M20 19v-4"/></svg>),
  break: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.2l7.2 2.7v5.4c0 4.4-3 8.3-7.2 9.5-4.2-1.2-7.2-5.1-7.2-9.5V5.9Z"/><path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8"/></svg>),
  rubric: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h9.5L19 7v13.5H6z"/><path d="M15 3.5V7h4"/><path d="M9 12.5l1.6 1.6L14 10.7"/><path d="M9 17h6"/></svg>),
  balances: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="3"/><path d="M2.5 10h19"/><path d="M16 14.5h2.5"/></svg>),
};

const ITEMS: { r: Route; label: ReactNode }[] = [
  { r: "pool", label: (<span>Pool <span style={css("opacity:.5;font-weight:500")}>· Win</span></span>) },
  { r: "wrap", label: "Wrap" },
  { r: "verify", label: (<span>Verify <span style={css("opacity:.5;font-weight:500")}>· the draw</span></span>) },
  { r: "position", label: (<span>Your position <span style={css("opacity:.5;font-weight:500")}>· yours only</span></span>) },
  { r: "break", label: (<span>Try to break it <span style={css("opacity:.5;font-weight:500")}>· 5 attacks</span></span>) },
  { r: "chat", label: (<span>Talk to it <span style={css("opacity:.5;font-weight:500")}>· MCP</span></span>) },
  { r: "balances", label: "Balances" },
];

export function Sidebar() {
  const { route, go } = useNav();
  const toast = useToast();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { chainId } = useAccount();
  const wrongChain = isConnected && chainId !== SEPOLIA_CHAIN_ID;

  /**
   * Which wallet, decided by the person using it.
   *
   * This used to pick one and prefer MetaMask when several were installed, which
   * meant a Rabby user with both got MetaMask and was never asked. EIP-6963
   * discovery already lists every detected extension separately; the only thing
   * missing was letting someone choose from that list.
   *
   * With exactly one option it still connects straight away — a chooser with one
   * row is a click for nothing.
   */
  const [picking, setPicking] = useState(false);

  const options = connectors.filter((c) => {
    if (c.type === "mock") return true;
    // wagmi keeps a generic "Injected" entry alongside the specific ones EIP-6963
    // found. Showing both offers the same wallet twice under two names.
    if (c.id === "injected" && connectors.some((o) => o.type === "injected" && o.id !== "injected")) return false;
    return true;
  });

  const doConnectWith = (c: (typeof connectors)[number]) => {
    setPicking(false);
    connect(
      { connector: c },
      {
        onError: (e: unknown) => {
          const err = e as { shortMessage?: string; message?: string };
          toast(err.shortMessage ?? err.message?.split("\n")[0] ?? "Wallet connection failed", "err");
        },
      },
    );
  };

  const doConnect = () => {
    if (isConnected) { disconnect(); return; }
    if (options.length === 0) {
      toast("No wallet found. Any browser wallet works — MetaMask, Rabby, Coinbase, Brave.", "err");
      return;
    }
    if (options.length === 1) { doConnectWith(options[0]!); return; }
    setPicking(true);
  };

  return (
    <aside className="rail" style={css("position:sticky;top:14px;align-self:flex-start;height:calc(100vh - 28px);width:264px;flex:none;background:var(--surface);border:1px solid var(--line);border-radius:24px;box-shadow:0 1px 2px rgba(20,18,12,.04),0 10px 30px rgba(20,18,12,.03)")}>
      <div style={css("display:flex;flex-direction:column;height:100%;padding:22px 15px 16px")}>
        <div style={css("display:flex;align-items:center;gap:9px;padding:2px 9px 6px")}>
          {/* AB. The mark beside LIVE text, not the PNG lockup.
              The lockup is set in Poppins, which is not one of this site's faces —
              using it here would either import a third font or render the wordmark
              in a typeface nothing else uses. The mark is an image because it is a
              drawing; the name is text because text stays crisp at every size and
              inherits the palette. The lockup keeps the favicon, the OG card and
              the README, where it sits alone. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/savetogether-mark-512.png" alt="" width={26} height={26} style={css("display:block;border-radius:6px")} />
          <span style={css("font:800 21px var(--display);letter-spacing:-.03em;color:var(--ink)")}>SAVETOGETHER</span>
        </div>
        <p style={css("margin:0 9px 18px;font:500 11.5px/1.45 var(--display);color:var(--ink-3)")}>
          No-loss prize savings.<br />Balance, odds and result all encrypted.
        </p>

        <nav style={css("display:flex;flex-direction:column;gap:3px")}>
          {ITEMS.map((it) => (
            <button className="navitem" key={it.r} style={navStyle(route === it.r)} onClick={() => go(it.r)}>
              {ICON[it.r]}<span>{it.label}</span>
            </button>
          ))}
        </nav>

        <div style={css("flex:1")} />

        <div style={css("margin-bottom:10px;padding:11px 12px;border-radius:13px;background:var(--surface-2);border:1px solid var(--line)")}>
          {/* This said "Sepolia testnet" as a hardcoded string, whatever the wallet
              was actually on. `lib/chain.ts` exists precisely because `useChainId()`
              reports the CONFIGURED chain rather than the connected one — and the one
              place a user looks to check their network was asserting the thing that
              library was written to disprove. A wallet on mainnet saw a green pip,
              its own address, and the word Sepolia, then pressed buttons that were
              disabled and looked enabled. */}
          <div style={css("font:700 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Network</div>
          <div style={css("display:flex;align-items:center;gap:7px;margin-top:5px")}>
            <span style={css(`width:7px;height:7px;border-radius:50%;background:${wrongChain ? "var(--red)" : "#8a63d2"}`)} />
            <span style={css(`font:650 12.5px var(--display);color:${wrongChain ? "var(--red)" : "var(--ink-2)"}`)}>
              {!isConnected ? "Sepolia testnet" : wrongChain ? "Wrong network" : "Sepolia testnet"}
            </span>
          </div>
          {wrongChain && (
            <>
              <p style={css("margin:6px 0 0;font:400 10.5px/1.5 var(--display);color:var(--red)")}>
                Your wallet is on chain {chainId}. Everything here needs Sepolia, so every button is
                disabled until you switch.
              </p>
              <button
                onClick={() => switchChain({ chainId: SEPOLIA_CHAIN_ID })}
                disabled={switching}
                style={css(`margin-top:7px;width:100%;padding:8px;border-radius:10px;border:none;background:var(--accent);font:700 11.5px var(--display);color:var(--on-accent);cursor:${switching ? "wait" : "pointer"}`)}
              >
                {switching ? "Ask your wallet…" : "Switch to Sepolia"}
              </button>
            </>
          )}
        </div>

        <button
          onClick={doConnect}
          style={css("width:100%;display:flex;align-items:center;justify-content:center;gap:9px;padding:13px 14px;border-radius:14px;border:1px solid var(--line-2);background:#fff;cursor:pointer;font:650 12.5px var(--display);color:var(--ink);letter-spacing:.03em")}
        >
          {isConnected ? (
            <>
              <span style={css("width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(28,143,90,.16)")} />
              <span style={css("font-family:var(--mono);font-weight:600;font-size:12.5px;letter-spacing:0")}>{shortAddr(address)}</span>
            </>
          ) : isPending ? (
            <>
              <span style={css("width:14px;height:14px;border:2px solid var(--line-2);border-top-color:var(--ink);border-radius:50%;display:inline-block;animation:spin .7s linear infinite")} />
              <span>CONNECTING…</span>
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="3"/><path d="M2.5 9.5h19"/><circle cx="17.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>
              <span>CONNECT WALLET</span>
            </>
          )}
        </button>

        {/* The chooser. Only when there is a choice: with one wallet installed
            doConnect() connects straight through and this never renders. */}
        {picking && (
          <div
            onClick={() => setPicking(false)}
            style={css("position:fixed;inset:0;z-index:50;background:rgba(15,29,42,.42);display:flex;align-items:center;justify-content:center;padding:18px")}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={css("width:100%;max-width:330px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 18px 50px rgba(20,18,12,.18)")}
            >
              <div style={css("font:750 14px var(--display);color:var(--ink)")}>Choose a wallet</div>
              <p style={css("margin:5px 0 12px;font:400 11px/1.5 var(--display);color:var(--ink-3)")}>
                Any of these works. The app never sees a key — it asks your wallet to sign, and every
                encrypted value is decrypted in this browser.
              </p>
              <div style={css("display:flex;flex-direction:column;gap:7px")}>
                {options.map((c) => (
                  <button
                    key={c.uid}
                    onClick={() => doConnectWith(c)}
                    disabled={isPending}
                    style={css("display:flex;align-items:center;gap:10px;width:100%;padding:11px 13px;border-radius:12px;border:1px solid var(--line-2);background:var(--surface-2);font:650 13px var(--display);color:var(--ink);cursor:pointer;text-align:left")}
                  >
                    {c.icon !== undefined && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.icon} alt="" width={18} height={18} style={css("border-radius:5px")} />
                    )}
                    <span style={css("flex:1;min-width:0")}>{c.name}</span>
                    {c.type === "mock" && (
                      <span style={css("font:600 9.5px var(--display);color:var(--ink-3)")}>read-only</span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setPicking(false)}
                style={css("margin-top:11px;width:100%;padding:9px;border-radius:11px;border:none;background:transparent;font:600 12px var(--display);color:var(--ink-3);cursor:pointer")}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
