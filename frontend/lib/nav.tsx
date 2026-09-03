"use client";
import { createContext, useContext, useState, ReactNode } from "react";

/**
 * Which screen is showing.
 *
 * V1. `vault` is still a valid route and still renders, but it is no longer in the
 * sidebar. That screen was written for a judge rather than a user: its largest
 * control was `joinVault`, which moves the POOL's principal and not the visitor's,
 * and it was labelled "Earn" on a page where nothing earns. The part a user needed
 * — where a deposit actually goes — is now a strip on Pool; the composition proof
 * is on Verify, whose reader wants it. The freed slot went to `position`.
 *
 * Eight, and the order is the product's argument rather than a menu: money comes
 * in, it earns, it becomes a prize, ANYONE CAN CHECK THE DRAW WAS FAIR, ANYONE
 * CAN TRY TO BREAK IT, the brief is answered with evidence, and an agent can do
 * the whole thing for you. Verify sits next to Vault because it is the claim the
 * rest of the product rests on; Break sits next to Verify because a privacy claim
 * is only worth what an attempt to defeat it costs.
 * The page used to be one column of unrelated panels, which made it impossible
 * to tell what any of it was for.
 */
export type Route = "pool" | "wrap" | "vault" | "verify" | "position" | "break" | "rubric" | "chat" | "balances";

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
