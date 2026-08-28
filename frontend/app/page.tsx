"use client";
import dynamic from "next/dynamic";

// Browser-only: a wallet and the FHE SDK worker. Rendering it client-only avoids
// SSR of code that has no server equivalent, and the App Router mount race with it.
const App = dynamic(() => import("../components/App"), { ssr: false });

export default function Page() {
  return <App />;
}
