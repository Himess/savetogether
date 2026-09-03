"use client";
import { createContext, useContext, useState, ReactNode } from "react";

/**
 * Which screen is showing.
 *
 * Six, and the order is the product's argument rather than a menu: money comes
 * in, it earns, it becomes a prize, ANYONE CAN CHECK THE DRAW WAS FAIR, and an
 * agent can do the whole thing for you. Verify sits next to Vault because it is
 * the claim the rest of the product rests on, not an appendix to it.
 * The page used to be one column of unrelated panels, which made it impossible
 * to tell what any of it was for.
 */
export type Route = "pool" | "wrap" | "vault" | "verify" | "chat" | "balances";

interface NavState {
  route: Route;
  go: (r: Route) => void;
}

const Ctx = createContext<NavState | null>(null);

export const useNav = (): NavState => {
  const c = useContext(Ctx);
  if (c === null) throw new Error("useNav outside provider");
  return c;
};

export function NavProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>("pool");
  const go = (r: Route) => {
    setRoute(r);
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  };
  return <Ctx.Provider value={{ route, go }}>{children}</Ctx.Provider>;
}
