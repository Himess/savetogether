import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * C1 — the indistinguishability result, re-run on the tiered shape.
 *
 * The 306-sample result no longer describes the contract: `accrue` ran one
 * `FHE.gt` and one `FHE.select`, and now runs three of each with the outcomes
 * folded through a nested chain. A result that holds across three comparisons is
 * STRONGER evidence than the original, and one that does not would be the single
 * most important thing to find before shipping. Either way it has to be measured
 * again rather than assumed to carry over.
 *
 * METHOD, unchanged from the original so the two are comparable:
 *
 *   - The unit of analysis is the ADDRESS, not the transaction. Two accruals of
 *     the same address are one observation, not two.
 *   - EXECUTION gas, not `gasUsed`. Intrinsic calldata cost varies with the
 *     zero-byte count of the address argument, which is a property of the
 *     address and has nothing to do with whether it won. Subtracting it is the
 *     difference between measuring the contract and measuring the alphabet.
 *
 * WHAT CHANGED, and it is a deliberate weakening that has to be stated: the
 * original ran on Sepolia. At the tiered cost a 300-sample Sepolia run is about
 * 0.33 ETH, a third of the keeper's remaining budget, and starving the keeper to
 * re-measure a property would trade a live pool for a number. Gas is
 * deterministic in the EVM, so this runs locally at full sample size; the HCU
 * half — which is what Sepolia was needed for — is settled separately by the
 * operation sequence being identical, and `spikes/a1-tier-hcu.ts` measured that
 * on chain.
 */
const DAY = 24 * 60 * 60;
const USERS = 12;
const DRAWS = 26; // 12 x 26 = 312 accruals, over the original 306

/** Intrinsic cost of a transaction's calldata, EIP-2028. */
function intrinsic(data: string): bigint {
  const bytes = ethers.getBytes(data);
  let cost = 21_000n;
  for (const b of bytes) cost += b === 0 ? 4n : 16n;
  return cost;
}

interface Sample {
  who: string;
  draw: number;
  won: boolean;
  execution: bigint;
}

describe("C1 — winner and loser are indistinguishable across three tiers", function () {
  this.timeout(600_000);

  it("measures every accrual and finds no separation by outcome", async () => {
    await fhevm.initializeCLIApi();
    const signers = await ethers.getSigners();
    const funder = signers[0]!;
    const users = signers.slice(1, 1 + USERS);
    expect(users.length).to.equal(USERS, "hardhat must provide enough signers");

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("PrizePoolHarness");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const w of [funder, ...users]) {
      await (await token.mint!(w.address, 50_000_000n)).wait();
      await (await token.connect(w).setOperator!(poolAddr, until)).wait();
    }

    // The shape that ships.
    await (await pool.setTiers!([25_000n, 5_000n, 1_000n], [100n, 10n, 1n])).wait();
    const seed = await fhevm.createEncryptedInput(poolAddr, funder.address).add64(40_000_000n).encrypt();
    await (await pool.fundReserve!(seed.handles[0], seed.inputProof)).wait();

    // Unequal balances on purpose: equal ones would make every threshold
    // comparison the same shape, which is the easy case rather than the real one.
    //
    // Balances and deposit times are recorded so each weight can be reproduced
    // off chain. The contract will not tell us who won — that is the product —
    // so the classification has to come from arithmetic we can do ourselves.
    const balance: bigint[] = [];
    const since: bigint[] = [];
    for (let i = 0; i < users.length; i++) {
      const amount = BigInt(1_000 * (i + 1));
      const e = await fhevm.createEncryptedInput(poolAddr, users[i]!.address).add64(amount).encrypt();
      const rc = await (await pool.connect(users[i]!).deposit!(e.handles[0], e.inputProof)).wait();
      const blk = await ethers.provider.getBlock(rc!.blockNumber);
      balance.push(amount);
      since.push(BigInt(blk!.timestamp));
    }

    /** balance x time held, which is exactly what the contract accumulates. */
    const cum = (i: number, at: bigint): bigint => (at <= since[i]! ? 0n : balance[i]! * (at - since[i]!));

    const samples: Sample[] = [];
    const iface = pool.interface;

    for (let draw = 1; draw <= DRAWS; draw++) {
      await ethers.provider.send("evm_increaseTime", [DAY]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.openDraw!()).wait();

      // Weights here run from 8.64e7 to 1.04e9 (balance x one day), so the
      // total has to sit ABOVE them or every threshold falls under every weight
      // and the whole sample is winners — which is what the first run produced.
      // Varied per draw so the split is not the same addresses every time.
      const total = 1_800_000_000n + BigInt(draw) * 40_000_000n;
      await (await pool.forceReveal!(draw, BigInt(draw * 7919), total)).wait();

      const d = await pool.drawAt!(draw);
      const from = BigInt(d.periodStart);
      const to = BigInt(d.snapshotAt);

      for (let i = 0; i < users.length; i++) {
        const u = users[i]!;
        const w = cum(i, to) - cum(i, from);
        // Won if ANY tier is cleared; the nested select pays the best one, but
        // for classification the question is only won-or-not.
        let won = false;
        for (let t = 0; t < 3; t++) {
          const th = BigInt(await pool["thresholdFor(uint32,address,uint8)"]!(draw, u.address, t));
          if (w > th) { won = true; break; }
        }

        const rc = await (await pool.accrue!(u.address, draw)).wait();
        const data = iface.encodeFunctionData("accrue", [u.address, draw]);
        samples.push({ who: u.address, draw, won, execution: rc!.gasUsed - intrinsic(data) });
      }
    }

    // ---- the analysis ----
    //
    // STRATIFIED BY DRAW, and that correction is load-bearing. A first run
    // reported two distinct execution costs and it would have been easy to call
    // that a leak; it is the `_snapshotCumulative` cache, which is cold on the
    // first draw an address appears in and warm afterwards. That is a property of
    // the DRAW INDEX, not of the outcome, and comparing across draws would have
    // measured the cache and called it a distinguisher.
    const byDraw = new Map<number, Sample[]>();
    for (const s of samples) {
      const arr = byDraw.get(s.draw) ?? [];
      arr.push(s);
      byDraw.set(s.draw, arr);
    }
    let mixedDraws = 0;
    const separated: string[] = [];
    for (const [drawId, group] of byDraw) {
      const w = new Set(group.filter((g) => g.won).map((g) => String(g.execution)));
      const l = new Set(group.filter((g) => !g.won).map((g) => String(g.execution)));
      if (w.size === 0 || l.size === 0) continue;
      mixedDraws++;
      for (const v of w) if (!l.has(v)) separated.push(`draw ${drawId}: ${v} only for winners`);
      for (const v of l) if (!w.has(v)) separated.push(`draw ${drawId}: ${v} only for losers`);
    }
    console.log(`      draws with both outcomes present: ${mixedDraws}`);
    console.log(`      within-draw separations: ${separated.length}`);
    for (const line of separated.slice(0, 5)) console.log(`        ${line}`);
    expect(mixedDraws).to.be.greaterThan(5, "need draws that contain both outcomes to compare within");
    expect(separated.length).to.equal(0, "an execution cost seen for only one outcome IN THE SAME DRAW is a leak");

    const winners = samples.filter((s) => s.won).map((s) => s.execution);
    const losers = samples.filter((s) => !s.won).map((s) => s.execution);

    const uniq = (xs: bigint[]): bigint[] => [...new Set(xs.map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
    const uw = uniq(winners);
    const ul = uniq(losers);

    console.log(`      samples          ${samples.length}  (${winners.length} won, ${losers.length} did not)`);
    console.log(`      distinct winner  ${uw.length}: ${uw.slice(0, 4).join(", ")}${uw.length > 4 ? " …" : ""}`);
    console.log(`      distinct loser   ${ul.length}: ${ul.slice(0, 4).join(", ")}${ul.length > 4 ? " …" : ""}`);

    expect(winners.length).to.be.greaterThan(20, "need a real winner population");
    expect(losers.length).to.be.greaterThan(20, "need a real loser population");

    // THE CLAIM. Not "the averages are close" — the sets of observed execution
    // costs must be the same set. A single value present on one side and absent
    // from the other is a distinguisher, however rare.
    const onlyWinner = uw.filter((x) => !ul.includes(x));
    const onlyLoser = ul.filter((x) => !uw.includes(x));
    console.log(`      values seen only on one side: ${onlyWinner.length} / ${onlyLoser.length}`);

    fs.mkdirSync(path.join(__dirname, "..", "spikes", "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "..", "spikes", "out", "c1-tiered-equality.json"),
      JSON.stringify(
        {
          shape: "3 tiers, k=[100,10,1], prizes=[25000,5000,1000]",
          samples: samples.length,
          winners: winners.length,
          losers: losers.length,
          distinctWinnerCosts: uw.map(String),
          distinctLoserCosts: ul.map(String),
          onlyWinner: onlyWinner.map(String),
          onlyLoser: onlyLoser.map(String),
        },
        null,
        2,
      ),
    );

    // Reported rather than asserted: across draws the cache state differs, so a
    // value can appear on one side purely because of which draw it came from.
    // The within-draw comparison above is the one that means anything.
    console.log(`      (cross-draw, for the record: ${onlyWinner.length} / ${onlyLoser.length})`);
  });
});
