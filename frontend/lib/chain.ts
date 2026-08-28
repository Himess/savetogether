"use client";

import { useAccount } from "wagmi";
import { SEPOLIA_CHAIN_ID } from "./addresses";

/**
 * Whether the WALLET is on Sepolia — not whether the app is configured for it.
 *
 * `useChainId()` reads the wagmi config's chain, and with a single configured
 * chain it returns Sepolia no matter where the wallet actually is. The app then
 * shows a green "Sepolia" badge, reads state from Sepolia over its own transport,
 * and builds writes for whatever chain the wallet is on — so a user on mainnet
 * sees a healthy-looking page and gets a transaction their wallet cannot pay for.
 *
 * `useAccount().chainId` is the connector's real chain. Everything that can send
 * a transaction gates on this.
 */
export function useOnSepolia(): boolean {
  const { isConnected, chainId } = useAccount();
  return isConnected && chainId === SEPOLIA_CHAIN_ID;
}
