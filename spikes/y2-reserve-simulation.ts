/**
 * Y2 — the reserve trajectory, simulated rather than estimated.
 *
 * The 4.7% clamp figure in the B0 derivation is an expected-path number: it
 * divides the grand prize by the MEAN growth rate and asks when that crosses.
 * The actual path is lumpy — tier 2 has k=1 so two winners in a draw is ordinary,
 * and a tier-1 win is 5 cUSDC against an expected growth of 5.33.
 *
 * This runs the real process: independent per-tier thresholds per user per draw,
 * best tier awarded, reserve clamped when short. No chain, no FHE — the draw is
 * arithmetic and the arithmetic is what is being checked.
 *
 *   npx ts-node spikes/y2-reserve-simulation.ts
 *   (or) npx hardhat run spikes/y2-reserve-simulation.ts
 */

/** Balances in whole cUSDC. The live pool, read from totalWeight/window. */
const LIVE = [12_001, 200, 200];

const H = 7.0782; // harvest per round, cUSDC
const K = [100, 10, 1];
const PRIZE = [25, 5, 1];
const ROUNDS = 50;
const TRIALS = 20_000;

interface Result {
  minReserve: number;
  anyClamp: boolean;
  grandClamp: boolean;
  firstClampRound: number;
  grandWins: number;
  paid: number;
}

function simulate(balances: number[], rounds: number): Result {
  const total = balances.reduce((a, b) => a + b, 0);
  let reserve = 0;
  let minReserve = Infinity;
  let anyClamp = false;
  let grandClamp = false;
  let firstClampRound = -1;
  let grandWins = 0;
  let paid = 0;

  for (let r = 1; r <= rounds; r++) {
    reserve += H;

    for (const w of balances) {
      // Independent uniform threshold per tier, exactly as the contract does.
      // Best (rarest) tier won takes precedence.
      let award = 0;
      let tier = -1;
      for (let t = 0; t < K.length; t++) {
        const p = w / (total * K[t]!);
        if (Math.random() < p) {
          award = PRIZE[t]!;
          tier = t;
          break; // t ascends from rarest, so the first hit is the best tier
        }
      }
      if (award === 0) continue;
      if (tier === 0) grandWins++;

      if (reserve >= award) {
        reserve -= award;
        paid += award;
      } else {
        anyClamp = true;
        if (firstClampRound < 0) firstClampRound = r;
        if (tier === 0) grandClamp = true;
      }
    }
    if (reserve < minReserve) minReserve = reserve;
  }
  return { minReserve, anyClamp, grandClamp, firstClampRound, grandWins, paid };
}

function pct(n: number, d: number): string {
  return ((100 * n) / d).toFixed(2) + "%";
}

function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i]!;
}

function run(label: string, balances: number[], rounds: number): void {
  const mins: number[] = [];
  let clamps = 0;
  let grandClamps = 0;
  let grandWins = 0;
  const clampRounds: number[] = [];

  for (let i = 0; i < TRIALS; i++) {
    const r = simulate(balances, rounds);
    mins.push(r.minReserve);
    if (r.anyClamp) { clamps++; clampRounds.push(r.firstClampRound); }
    if (r.grandClamp) grandClamps++;
    grandWins += r.grandWins;
  }
  mins.sort((a, b) => a - b);

  const total = balances.reduce((a, b) => a + b, 0);
  console.log(`\n  ${label}`);
  console.log(`    ${balances.length} participants, ${total.toLocaleString()} cUSDC, ${rounds} rounds, ${TRIALS.toLocaleString()} trials`);
  console.log(`    ANY clamp            ${pct(clamps, TRIALS).padStart(7)}   (${clamps})`);
  console.log(`    tier-0 clamp         ${pct(grandClamps, TRIALS).padStart(7)}   (${grandClamps})`);
  console.log(`    tier-0 wins/trial    ${(grandWins / TRIALS).toFixed(3)}   expected ${(rounds / K[0]!).toFixed(3)}`);
  if (clampRounds.length > 0) {
    clampRounds.sort((a, b) => a - b);
    console.log(`    first clamp round    median ${quantile(clampRounds, 0.5)}   p90 ${quantile(clampRounds, 0.9)}`);
  }
  console.log(`    reserve floor        p1 ${quantile(mins, 0.01).toFixed(2)}   p5 ${quantile(mins, 0.05).toFixed(2)}   median ${quantile(mins, 0.5).toFixed(2)}`);
}

function main(): void {
  console.log(`  k = [${K.join(", ")}]   prizes = [${PRIZE.join(", ")}] cUSDC   H = ${H}/round`);
  const E = PRIZE.reduce((a, p, i) => a + p / K[i]!, 0);
  console.log(`  E = ${E.toFixed(2)}/round   s = ${(H - E).toFixed(2)}/round   utilisation ${pct(E, H)}`);

  run("LIVE distribution, first 50 rounds (the warm-up window)", LIVE, ROUNDS);
  run("LIVE distribution, first 10 rounds (the real danger zone)", LIVE, 10);
  run("LIVE distribution, 288 rounds (the whole 6-day window)", LIVE, 288);

  // Robustness: the recommendation must not depend on one holder dominating.
  run("20 equal participants, 50 rounds", Array(20).fill(12_401 / 20), ROUNDS);
  run("100 equal participants, 50 rounds", Array(100).fill(12_401 / 100), ROUNDS);

  // What the rejected configuration actually does.
  console.log(`\n  ── the configuration B0 rejected, for comparison ──`);
  PRIZE[0] = 100; PRIZE[1] = 10; PRIZE[2] = 2;
  const E2 = PRIZE.reduce((a, p, i) => a + p / K[i]!, 0);
  console.log(`  prizes = [100, 10, 2]   E = ${E2.toFixed(2)}   utilisation ${pct(E2, H)}`);
  run("REJECTED config, first 50 rounds", LIVE, ROUNDS);
}

main();
