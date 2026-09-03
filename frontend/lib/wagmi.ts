import { http, createConfig } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";

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

// Injected (MetaMask) only — the design's single "CONNECT WALLET" button. Public Sepolia RPC.
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [...demoConnector, injected()],
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
