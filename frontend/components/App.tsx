"use client";

import { css } from "@/lib/css";
import { NavProvider, useNav } from "@/lib/nav";
import { ToastProvider } from "@/components/Toast";
import { Sidebar } from "@/components/Sidebar";
import { PoolScreen } from "@/components/screens/Pool";
import { WrapScreen } from "@/components/screens/Wrap";
import { VaultScreen } from "@/components/screens/Vault";
import { VerifyScreen } from "@/components/screens/Verify";
import { ChatScreen } from "@/components/screens/Chat";
import { BalancesScreen } from "@/components/screens/Balances";

/**
 * The shell.
 *
 * Five screens in the order the product argues for itself: money comes in and
 * becomes confidential, it earns, it becomes a prize, and an agent can do the
 * whole thing on your behalf. The page used to be one column of panels with no
 * relationship between them, which made it impossible to tell what any of it was
 * for — the sidebar is not decoration, it is the argument.
 */
function Screen() {
  const { route } = useNav();
  if (route === "wrap") return <WrapScreen />;
  if (route === "vault") return <VaultScreen />;
  if (route === "verify") return <VerifyScreen />;
  if (route === "chat") return <ChatScreen />;
  if (route === "balances") return <BalancesScreen />;
  return <PoolScreen />;
}

export function App() {
  return (
    <ToastProvider>
      <NavProvider>
        <div style={css("display:flex;gap:22px;padding:14px;min-height:100vh;align-items:flex-start")}>
          <Sidebar />
          <main style={css("flex:1;min-width:0;padding:14px 10px 60px")}>
            <Screen />
          </main>
        </div>
      </NavProvider>
    </ToastProvider>
  );
}

export default App;
