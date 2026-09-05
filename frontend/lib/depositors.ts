"use client";
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { keccak256, toHex } from "viem";
import { POOL } from "@/lib/addresses";

/** `Deposited(address indexed user, uint40 at, uint256 amount)`. */
const DEPOSITED = keccak256(toHex("Deposited(address,uint40,uint256)"));

/** The block this pool was deployed at. Scanning from 0 is what broke the keeper. */
const FROM = 11_600_000n;

/** The public Sepolia RPC refuses a range over 50,000. */
const CHUNK = 9_000n;

/**
 * How many distinct addresses have deposited into this pool.
 *
 * WHAT THIS COUNTS, EXACTLY: addresses that have ever sent a `Deposited`. Not
 * "current depositors" — an address that later withdrew everything is still in
 * here, and there is no honest way to exclude it, because the withdrawal amount
 * is encrypted and "did that empty the account" is precisely the question the
 * contract refuses to answer publicly. So the label on screen says *have
 * deposited*, in the past tense, rather than implying a live headcount.
 *
 * WHY COUNTING IS ALLOWED WHEN THE FEED IS NOT. `Activity` deliberately excludes
 * `Deposited`, `Withdrawn` and `Claimed` because those three are the exact events
 * §8's window solve consumes, and a timestamped feed of them would amplify a leak
 * the design merely tolerates. A COUNT is strictly less than that: it carries no
 * timing, no ordering and no address. The participant set was already enumerable
 * by anyone with an RPC endpoint and the README says so; this reads the size of
 * it and nothing else.
 *
 * Filtered by topic at the RPC, so it is one round trip per chunk and no block
 * timestamps are fetched.
 */
export function useDepositorCount(): number | null {
  const client = usePublicClient();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    void (async () => {
      try {
        const head = await client.getBlockNumber();
        const start = head > FROM ? FROM : 0n;
        const seen = new Set<string>();
        for (let f = start; f <= head; f += CHUNK) {
          const to = f + CHUNK - 1n > head ? head : f + CHUNK - 1n;
          const logs = (await client.getLogs({
            address: POOL,
            fromBlock: f,
            toBlock: to,
            topics: [DEPOSITED],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)) as unknown as { topics: readonly string[] }[];
          for (const l of logs) {
            if (l.topics[0] !== DEPOSITED) continue;
            const t = l.topics[1];
            if (t !== undefined) seen.add(t.toLowerCase());
          }
          if (cancelled) return;
        }
        if (!cancelled) setCount(seen.size);
      } catch {
        // A count that cannot be read renders as nothing rather than as a zero.
        // Zero depositors is a claim; "we could not reach the RPC" is not.
        if (!cancelled) setCount(null);
      }
    })();

    return () => { cancelled = true; };
  }, [client]);

  return count;
}
