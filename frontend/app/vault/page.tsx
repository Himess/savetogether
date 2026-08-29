"use client";
import dynamic from "next/dynamic";

// Client-only for the same reason the main page is: a wallet and the FHE SDK.
const VaultPage = dynamic(() => import("../../components/VaultPage"), { ssr: false });

export default function Page() {
  return <VaultPage />;
}
