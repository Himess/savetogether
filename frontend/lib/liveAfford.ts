import { HOSTED_URL } from "@/lib/addresses";

/**
 * The `can_afford` binary search, against the real server.
 *
 * Row 5 of "Try to break it" ran this locally — a copy of `coarsenBudget` and a
 * loop over a number the visitor typed. On a page whose banner says *nothing here
 * is staged*, a local simulation is exactly what staged means, and it made the
 * strongest claim on the site the one row that proved nothing.
 *
 * This sends real MCP `tools/call` requests to the deployed server, so the answers
 * come from the same coarsening the production path uses. Two consequences, and
 * both are stated on screen rather than hidden:
 *
 *   - It needs a session, because `can_afford` takes a session token. Without one
 *     the row says so instead of pretending.
 *   - The server allows 60 calls a minute. A full search is ~40 probes and would
 *     sit on top of that ceiling, so this runs a bounded number and reports the
 *     count. A truthful ten is worth more than a simulated forty.
 *
 * The token goes in the path because that is what an MCP connector URL is — the
 * shape W1 retired for `/api/session` is still correct here, and it is the user's
 * own token being sent by their own browser.
 */
export interface Probe {
  readonly call: number;
  readonly amount: bigint;
  readonly yes: boolean;
}

export interface LiveResult {
  readonly probes: readonly Probe[];
  readonly lo: bigint;
  readonly hi: bigint;
  readonly exhausted: boolean;
  readonly token: string;
}

const U = 1_000_000n;

async function callTool(token: string, amount: bigint, id: number): Promise<boolean> {
  const res = await fetch(`${HOSTED_URL}/mcp/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "can_afford", arguments: { token: "cUSDC", amount: (Number(amount) / 1e6).toString() } },
    }),
  });
  if (res.status === 429) throw new Error("rate-limited: the server allows 60 calls a minute");
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  const text = await res.text();
  // The MCP endpoint may answer as JSON or as an SSE frame; take the last JSON object.
  const line = text.trim().split("\n").filter((l) => l.trim().startsWith("{") || l.startsWith("data:")).pop() ?? text;
  const body = JSON.parse(line.replace(/^data:\s*/, ""));
  const payload = body?.result?.content?.[0]?.text ?? JSON.stringify(body?.result ?? body);
  return /\byes\b|"affordable"\s*:\s*true|\btrue\b/i.test(String(payload));
}

/**
 * Bisects the budget with real calls, up to `maxProbes`.
 *
 * Returns the bracket rather than a single number, because the bracket IS the
 * finding: coarsening means the search converges to a 50-token bucket and stops,
 * and a run that reports one number would be claiming a precision the server
 * refuses to give.
 */
export async function liveSearch(
  token: string,
  upper: bigint,
  maxProbes: number,
  onProbe?: (p: Probe) => void,
): Promise<LiveResult> {
  let lo = 0n;
  let hi = upper;
  const probes: Probe[] = [];

  for (let i = 0; i < maxProbes && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    const yes = await callTool(token, mid, i + 1);
    const p: Probe = { call: i + 1, amount: mid, yes };
    probes.push(p);
    onProbe?.(p);
    if (yes) lo = mid; else hi = mid;
  }

  return { probes, lo, hi, exhausted: hi - lo <= 1n, token };
}

export const DEFAULT_UPPER = 10_000n * U;
