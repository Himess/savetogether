"use client";
import { CSSProperties, ReactNode } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { css } from "@/lib/css";
import { useNav, type Route } from "@/lib/nav";
import { shortAddr } from "@/lib/format";
import { useToast } from "@/components/Toast";

function navStyle(active: boolean): CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: "11px", width: "100%",
    padding: "9px 12px", borderRadius: "12px", cursor: "pointer",
    fontFamily: "var(--display)", fontSize: "14.5px", fontWeight: active ? 650 : 500,
    letterSpacing: "-0.01em", textAlign: "left", whiteSpace: "nowrap",
    color: active ? "#1a1a1a" : "#4a473e", backgroundColor: "transparent",
    backgroundImage: active ? "linear-gradient(180deg,#fff0a6,#ffda40)" : "none",
    border: active ? "1px solid rgba(0,0,0,.05)" : "1px solid transparent",
    boxShadow: active ? "0 6px 15px rgba(255,210,8,.28), inset 0 1px 0 rgba(255,255,255,.55)" : "none",
  };
}

const ICON: Record<Route, ReactNode> = {
  pool: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 16.5c1.6 0 1.6-1.4 3.2-1.4s1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4"/><path d="M3 20.5c1.6 0 1.6-1.4 3.2-1.4s1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4"/><path d="M12 3.5l1.7 3.6 3.9.5-2.8 2.7.7 3.9L12 12.3l-3.5 1.9.7-3.9-2.8-2.7 3.9-.5z"/></svg>),
  wrap: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="9" width="16" height="11" rx="2.5"/><path d="M8 9V6.5a4 4 0 0 1 8 0V9"/><circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none"/></svg>),
  vault: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6.4" rx="7.3" ry="3.1"/><path d="M4.7 6.4v5.4c0 1.7 3.3 3.1 7.3 3.1s7.3-1.4 7.3-3.1V6.4"/><path d="M4.7 11.8v5.4c0 1.7 3.3 3.1 7.3 3.1s7.3-1.4 7.3-3.1v-5.4"/></svg>),
  chat: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 12c0 4.3-3.8 7.7-8.5 7.7-1.1 0-2.2-.2-3.2-.5L3.5 21l1.4-4.1A7.3 7.3 0 0 1 3.5 12c0-4.3 3.8-7.7 8.5-7.7s8.5 3.4 8.5 7.7Z"/><path d="M8.5 11.5h7M8.5 14.5h4"/></svg>),
  balances: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="3"/><path d="M2.5 10h19"/><path d="M16 14.5h2.5"/></svg>),
};

const ITEMS: { r: Route; label: ReactNode }[] = [
  { r: "pool", label: (<span>Pool <span style={css("opacity:.5;font-weight:500")}>· Win</span></span>) },
  { r: "wrap", label: "Wrap" },
  { r: "vault", label: (<span>Vault <span style={css("opacity:.5;font-weight:500")}>· Earn</span></span>) },
  { r: "chat", label: (<span>Talk to it <span style={css("opacity:.5;font-weight:500")}>· MCP</span></span>) },
  { r: "balances", label: "Balances" },
];

export function Sidebar() {
  const { route, go } = useNav();
  const toast = useToast();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  // wagmi v2: connect() needs a connector INSTANCE from the config, not a fresh
  // injected() factory. EIP-6963 discovery populates `connectors` with each
  // detected wallet, so prefer MetaMask and fall back rather than guessing.
  const doConnect = () => {
    if (isConnected) { disconnect(); return; }
    const injected = connectors.filter(
      (c) => c.type === "injected" || /injected|metamask|rabby|coinbase|brave/i.test(c.name),
    );
    const pick = injected.find((c) => /metamask/i.test(c.name)) ?? injected[0] ?? connectors[0];
    if (pick === undefined) {
      toast("No wallet detected — install MetaMask, then reload", "err");
      return;
    }
    connect(
      { connector: pick },
      {
        onError: (e: unknown) => {
          const err = e as { shortMessage?: string; message?: string };
          toast(err.shortMessage ?? err.message?.split("\n")[0] ?? "Wallet connection failed", "err");
        },
      },
    );
  };

  return (
    <aside style={css("position:sticky;top:14px;align-self:flex-start;height:calc(100vh - 28px);width:264px;flex:none;background:var(--surface);border:1px solid var(--line);border-radius:24px;box-shadow:0 1px 2px rgba(20,18,12,.04),0 10px 30px rgba(20,18,12,.03)")}>
      <div style={css("display:flex;flex-direction:column;height:100%;padding:22px 15px 16px")}>
        <div style={css("display:flex;align-items:center;gap:9px;padding:2px 9px 6px")}>
          <svg width="23" height="25" viewBox="0 0 24 26" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12v11.4c0 1.3 1.5 2 2.5 1.1L6.6 22c.5-.5 1.4-.5 2 0l1.4 1.3c.6.5 1.4.5 2 0l1.4-1.3c.5-.5 1.4-.5 2 0l2.1 1.5c1 .9 2.5.2 2.5-1.1V12C22 6.48 17.52 2 12 2Z" fill="var(--ink)"/><circle cx="9" cy="12" r="1.55" fill="#fff"/><circle cx="15" cy="12" r="1.55" fill="#fff"/></svg>
          <span style={css("font:800 21px var(--display);letter-spacing:-.03em;color:var(--ink)")}>GHOSTPOOL</span>
        </div>
        <p style={css("margin:0 9px 18px;font:500 11.5px/1.45 var(--display);color:var(--ink-3)")}>
          No-loss prize savings.<br />Balance, odds and result all encrypted.
        </p>

        <nav style={css("display:flex;flex-direction:column;gap:3px")}>
          {ITEMS.map((it) => (
            <button key={it.r} style={navStyle(route === it.r)} onClick={() => go(it.r)}>
              {ICON[it.r]}<span>{it.label}</span>
            </button>
          ))}
        </nav>

        <div style={css("flex:1")} />

        <div style={css("margin-bottom:10px;padding:11px 12px;border-radius:13px;background:var(--surface-2);border:1px solid var(--line)")}>
          <div style={css("font:700 10px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)")}>Network</div>
          <div style={css("display:flex;align-items:center;gap:7px;margin-top:5px")}>
            <span style={css("width:7px;height:7px;border-radius:50%;background:#8a63d2")} />
            <span style={css("font:650 12.5px var(--display);color:var(--ink-2)")}>Sepolia testnet</span>
          </div>
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
      </div>
    </aside>
  );
}

export default Sidebar;
