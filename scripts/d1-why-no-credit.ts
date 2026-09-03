/**
 * Draw 34 credited nothing while the ordinary-tier threshold sat at 98.9% of
 * totalWeight. There are exactly two explanations and they are very different:
 *
 *   (a) weight <= threshold  -> an ordinary loss, the machine working
 *   (b) weight >  threshold  -> a WIN that the reserve could not fund, credited
 *                               zero and silent. That is the documented
 *                               under-payment (README "the reserve can still
 *                               under-pay, and it is silent when it does"),
 *                               observed live rather than simulated.
 *
 * `weightFor` grants the caller ACL on the handle, so the comparison the
 * contract makes in the encrypted domain can be reproduced in the clear here.
 *
 *   npx hardhat run scripts/d1-why-no-credit.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";

const POOL = "0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631";

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();
  const pool = await ethers.getContractAt("ConfidentialPrizePool", POOL, s!);

  const drawId = Number(process.env.DRAW ?? (await pool.drawCount!()));
  const d = await pool.drawAt!(drawId);
  console.log(`draw ${drawId}: status=${d.status} r=${d.r} totalWeight=${d.totalWeight}`);

  // weightFor is non-view: it recomputes the window difference and grants ACL.
  const tx = await pool.weightFor!(drawId, me);
  await tx.wait();
  const handle = await pool.weightFor!.staticCall(drawId, me);
  let weight: bigint | null = null;
  try {
    weight = (await fhevm.userDecryptEuint(FhevmType.euint128, handle, POOL, s!)) as bigint;
  } catch (e) {
    console.log("could not decrypt my weight:", String(e).split("\n")[0]!.slice(0, 90));
  }

  const rows: { tier: number; threshold: bigint; won: boolean | null }[] = [];
  for (let t = 0; t < 3; t++) {
    const th = (await pool["thresholdFor(uint32,address,uint8)"]!(drawId, me, t)) as bigint;
    rows.push({ tier: t, threshold: th, won: weight === null ? null : weight > th });
  }

  console.log(`\nmy weight over the window: ${weight ?? "unreadable"}`);
  console.log(`draw totalWeight:          ${d.totalWeight}`);
  if (weight !== null && d.totalWeight > 0n) {
    console.log(`my share of the window:    ${((Number(weight) / Number(d.totalWeight)) * 100).toFixed(2)}%`);
  }
  console.log("\ntier  threshold                 weight > threshold?");
  for (const r of rows) {
    console.log(
      `  ${r.tier}   ${String(r.threshold).padEnd(24)}  ${r.won === null ? "?" : r.won ? "YES — cleared this tier" : "no"}`,
    );
  }

  const best = rows.filter((r) => r.won).sort((a, b) => a.tier - b.tier)[0];
  const prizes = [
    Number(await pool.tierPrize!(0)) / 1e6,
    Number(await pool.tierPrize!(1)) / 1e6,
    Number(await pool.tierPrize!(2)) / 1e6,
  ];

  console.log("\n=================== VERDICT ===================");
  if (weight === null) {
    console.log("INCONCLUSIVE — weight not readable.");
  } else if (!best) {
    console.log("(a) ORDINARY LOSS. Weight cleared no tier; crediting zero is correct.");
  } else {
    console.log(`(b) WIN, UNPAID. Weight cleared tier ${best.tier} (prize ${prizes[best.tier]} cUSDC),`);
    console.log("    and `winnings` did not move. The only remaining branch in `accrue` is");
    console.log("    FHESafeMath.tryDecrease(_reserve, credit) returning funded=false, so");
    console.log("    `paid` was FHE.select(false, credit, 0) = 0.");
    console.log("");
    console.log("    This is the README's documented silent under-payment, observed on a");
    console.log("    live draw rather than simulated: a declined tryDecrease is exactly");
    console.log("    what losing looks like, and nothing on chain distinguishes them.");
  }

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/d1-why-no-credit.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        drawId,
        r: d.r.toString(),
        totalWeight: d.totalWeight.toString(),
        myWeight: weight?.toString() ?? null,
        thresholds: rows.map((r) => ({ tier: r.tier, threshold: r.threshold.toString(), cleared: r.won })),
        verdict: weight === null ? "inconclusive" : best ? `win-unpaid-tier-${best.tier}` : "ordinary-loss",
      },
      null,
      2,
    ),
  );
  console.log("\nwrote out/d1-why-no-credit.json");
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
