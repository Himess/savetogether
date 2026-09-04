/**
 * The §8 window solve, in the browser, against the pool the visitor is looking at.
 *
 * This is the only attack on the "Try to break it" page that finds a real leak in
 * the live deployment rather than reproducing a measurement. It uses nothing
 * private: public draw records, public event logs, public timestamps.
 *
 *   totalWeight_N = prevBalance x window + delta x (snapshotAt - eventTime)
 *
 * `window`, `snapshotAt` and `totalWeight` come from `drawAt`. `eventTime` is a
 * block timestamp on a `Deposited` / `Withdrawn` / `Claimed` log. `prevBalance` is
 * the previous draw's own aggregate divided by its window. So in a window holding
 * exactly ONE balance-changing event, `delta` is the only unknown and the equation
 * solves rather than bounds.
 *
 * THE EVENT FILTER IS THE WHOLE THING. The first version of this omitted `Claimed`,
 * which also moves a balance — through `_drain` — and it returned clean integers
 * that were confidently wrong about real people: three windows "solved", two of them
 * wrong. Almost right is indistinguishable from right, which makes the incomplete
 * version more dangerous than the correct one. If a balance-moving event is ever
 * added to the contract, it must be added here too or this silently starts lying.
 *
 * Nothing here leaves the browser and nothing here is shareable: the caller renders
 * the result and never puts it in a URL.
 */
export interface DrawRow {
  readonly id: number;
  readonly periodStart: number;
  readonly snapshotAt: number;
  readonly totalWeight: bigint;
  readonly revealed: boolean;
}

export interface BalanceEvent {
  readonly kind: "deposit" | "withdraw" | "claim";
  readonly who: `0x${string}`;
  readonly t: number;
  readonly tx: `0x${string}`;
}

export interface Solved {
  readonly draw: number;
  readonly who: `0x${string}`;
  readonly kind: BalanceEvent["kind"];
  readonly delta: bigint;
  readonly exact: boolean;
  readonly tx: `0x${string}`;
}

export interface SolveReport {
  readonly events: number;
  readonly windows: number;
  readonly singleEventWindows: number;
  readonly solved: readonly Solved[];
  /** Windows that met condition 1 and failed 2 or 3, with the reason. */
  readonly rejected: readonly { draw: number; why: string }[];
}

export function solveWindows(draws: readonly DrawRow[], events: readonly BalanceEvent[]): SolveReport {
  const byId = [...draws].filter((d) => d.revealed).sort((a, b) => a.id - b.id);
  const solved: Solved[] = [];
  const rejected: { draw: number; why: string }[] = [];
  let singles = 0;

  for (let i = 1; i < byId.length; i++) {
    const d = byId[i]!;
    const prev = byId[i - 1]!;
    const window = d.snapshotAt - d.periodStart;
    const prevWindow = prev.snapshotAt - prev.periodStart;
    if (window <= 0 || prevWindow <= 0) continue;

    const inWindow = events.filter((e) => e.t > d.periodStart && e.t <= d.snapshotAt);
    if (inWindow.length !== 1) continue;
    singles++;

    // Condition 2: a revealed predecessor, so prevBalance exists at all.
    if (prev.totalWeight === 0n) { rejected.push({ draw: d.id, why: "previous aggregate is zero" }); continue; }

    // Condition 3: prevBalance has to divide evenly, or integer truncation
    // propagates and the answer is close rather than exact — which is precisely
    // the failure mode that produced confidently wrong numbers.
    if (prev.totalWeight % BigInt(prevWindow) !== 0n) {
      rejected.push({ draw: d.id, why: "carried-in balance does not divide evenly" });
      continue;
    }
    const prevBalance = prev.totalWeight / BigInt(prevWindow);

    const e = inWindow[0]!;
    const after = BigInt(d.snapshotAt - e.t);
    if (after === 0n) { rejected.push({ draw: d.id, why: "event landed on the snapshot" }); continue; }

    const base = prevBalance * BigInt(window);
    const residual = d.totalWeight - base;
    const exact = residual % after === 0n;
    if (!exact) { rejected.push({ draw: d.id, why: "residual does not divide — close, not exact" }); continue; }

    solved.push({ draw: d.id, who: e.who, kind: e.kind, delta: residual / after, exact, tx: e.tx });
  }

  return { events: events.length, windows: Math.max(0, byId.length - 1), singleEventWindows: singles, solved, rejected };
}
