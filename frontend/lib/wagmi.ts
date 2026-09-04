import { http, createConfig } from "wagmi";
import { sepolia } from "wagmi/chains";
import { coinbaseWallet, injected, mock, walletConnect } from "wagmi/connectors";

/**
 * A read-only stand-in for a wallet, for screenshots and demos.
 *
 * Off unless `NEXT_PUBLIC_DEMO_ADDRESS` is set, and absent from the connector list
 * entirely when it is not — so a production build has no path to it.
 *
 * It supplies an ADDRESS and nothing else. Every read still hits the real Sepolia
 * RPC and returns that address's real state, which is the point: it makes the
 * plaintext, per-address parts of the UI — the accrual badge above all — reachable
 * without a browser extension. It cannot sign, so anything needing a signature
 * (the decrypt permit, every write) still fails, correctly and visibly.
 */
const demo = process.env.NEXT_PUBLIC_DEMO_ADDRESS;
const demoConnector =
  demo && /^0x[0-9a-fA-F]{40}$/.test(demo)
    ? [mock({ accounts: [demo as `0x${string}`], features: { defaultConnected: true } })]
    : [];

/**
 * WalletConnect, if a project id is configured.
 *
 * This is the only connector that needs an account somewhere else: WalletConnect
 * relays through their infrastructure and will not run without an id from
 * `cloud.reown.com`. So it is opt-in rather than absent — set
 * `NEXT_PUBLIC_WALLETCONNECT_ID` and every mobile wallet with a QR scanner works;
 * leave it unset and the app is exactly as it was.
 *
 * It is the biggest single gap for a phone, because a mobile browser has no
 * injected extension to find.
 */
const wcId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID;
const walletConnectConnector =
  wcId !== undefined && wcId.length > 0
    ? [walletConnect({ projectId: wcId, showQrModal: true })]
    : [];

/**
 * Which wallets can open this app.
 *
 * `injected()` is not "MetaMask only" and never was: EIP-6963 discovery puts every
 * detected browser extension in the list separately — Rabby, Brave, Coinbase,
 * Zerion, OKX, Trust. What was MetaMask-only was the SIDEBAR, which picked one for
 * you and preferred MetaMask when several were installed. It now asks.
 *
 * Coinbase Wallet is added because it needs no project id and, unlike an
 * extension, its Smart Wallet works in a mobile browser through a passkey — which
 * matters now that the layout is usable on a phone. A responsive app nobody can
 * connect to on a phone is half a feature.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [
    ...demoConnector,
    injected(),
    coinbaseWallet({ appName: "SaveTogether", preference: "all" }),
    ...walletConnectConnector,
  ],
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
  },
  ssr: false, // fully client-rendered app (dynamic ssr:false); avoids wagmi's SSR cookie path breaking the build
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
