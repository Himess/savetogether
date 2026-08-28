"use client";

import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { SEPOLIA_CHAIN_ID } from "../lib/addresses";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Wallet connection and the network guard.
 *
 * The guard says which chain is selected and which is needed, rather than
 * "wrong network". A judge arriving on mainnet should be able to fix it from the
 * message alone, and the one-click switch is there because reading an
 * instruction is slower than pressing a button.
 */
export function Connect() {
  // The connector's chain, not the config's. See lib/chain.ts.
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];
  const wrongChain = isConnected && chainId !== undefined && chainId !== SEPOLIA_CHAIN_ID;

  if (!isConnected) {
    return (
      <div className="panel">
        <h2>Wallet</h2>
        <div className="row">
          <button disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
            {isPending ? "Connecting…" : "Connect wallet"}
          </button>
          <span className="dim">Sepolia testnet. Nothing here touches mainnet.</span>
        </div>
      </div>
    );
  }

  return (
    <>
      {wrongChain && (
        <div className="banner">
          Your wallet is on chain {chainId}; GhostPool runs on Sepolia ({SEPOLIA_CHAIN_ID}).{" "}
          <button className="ghost" onClick={() => switchChain({ chainId: SEPOLIA_CHAIN_ID })}>
            Switch to Sepolia
          </button>
        </div>
      )}
      <div className="panel">
        <h2>Wallet</h2>
        <div className="row">
          <span className="addr">{short(address!)}</span>
          <span className={wrongChain ? "pill pill--open" : "pill pill--live"}>
            {wrongChain ? `chain ${chainId}` : "Sepolia"}
          </span>
          <button className="ghost" onClick={() => disconnect()}>Disconnect</button>
        </div>
      </div>
    </>
  );
}
