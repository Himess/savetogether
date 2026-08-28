/**
 * Pools the equality batches and reports where the measurement stands.
 *
 * Batches are separate invocations against separate pool instances, which is a
 * consequence of the run having been killed twice rather than a design choice.
 * They are poolable because each sample is an independent measurement of the same
 * function on the same contract code, under the same arm construction. What is
 * NOT pooled is round 1 of any batch: that round initialises `_pending` and
 * `_winnings`, so it runs two fewer `tryAdd`s and belongs to a different
 * distribution — the confound found in findings.md §11.2.
 *
 *   node scripts/pool-equality.js
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "out");

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const chiP = (chi) => 1 - erf(Math.sqrt(chi / 2));

const samples = [];
for (const f of fs.readdirSync(OUT).filter((f) => /^equality-.*\.json$/.test(f))) {
  const raw = JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8"));
  const batch = f.replace(/^equality-|\.json$/g, "");
  for (const s of raw.samples ?? []) samples.push({ ...s, batch });
  const kept = (raw.samples ?? []).filter((s) => s.round > 1).length;
  console.log(`  ${f.padEnd(22)} ${String((raw.samples ?? []).length).padStart(4)} samples, ${kept} steady-state`);
}

const steady = samples.filter((s) => s.round > 1);
console.log(`\npooled steady-state: ${steady.length} samples`);

const ops = [...new Set(steady.map((s) => s.ops))];
const hcus = [...new Set(steady.map((s) => s.hcu))];
console.log(`distinct op sequences : ${ops.length}  ${ops.length === 1 ? "(identical)" : ops.join(" | ")}`);
console.log(`distinct HCU values   : ${hcus.length}  ${hcus.join(", ")}`);

const vals = [...new Set(steady.map((s) => s.exec))].sort();
const t = { winner: {}, loser: {} };
for (const s of steady) t[s.arm][s.exec] = (t[s.arm][s.exec] ?? 0) + 1;

console.log(`\narm      ${vals.map((v) => String(v).padStart(9)).join("")}      n    low rate`);
const rows = [];
for (const arm of ["winner", "loser"]) {
  const row = vals.map((v) => t[arm][v] ?? 0);
  rows.push(row);
  const n = row.reduce((a, b) => a + b, 0);
  console.log(
    `${arm.padEnd(9)}${row.map((x) => String(x).padStart(9)).join("")}   ${String(n).padStart(4)}   ${((100 * row[0]) / n).toFixed(1)}%`,
  );
}

if (vals.length === 2) {
  const [a, b] = rows[0];
  const [c, d] = rows[1];
  const N = a + b + c + d;
  const yates = (N * Math.pow(Math.abs(a * d - b * c) - N / 2, 2)) / ((a + b) * (c + d) * (a + c) * (b + d));
  const plain = (N * Math.pow(a * d - b * c, 2)) / ((a + b) * (c + d) * (a + c) * (b + d));
  const spread = Math.abs(a / (a + b) - c / (c + d)) * 100;
  const nPer = (a + b + c + d) / 2;
  const pbar = (a + c) / N;
  const z = 1.959964 + 0.841621;
  const detect = Math.sqrt((z * z * 2 * pbar * (1 - pbar)) / nPer) * 100;

  console.log(`\nobserved spread        : ${spread.toFixed(1)} points`);
  console.log(`chi-square (Yates)     : ${yates.toFixed(4)}  p = ${chiP(yates).toFixed(4)}`);
  console.log(`chi-square (plain)     : ${plain.toFixed(4)}  p = ${chiP(plain).toFixed(4)}`);
  console.log(`80% power detects      : +/-${detect.toFixed(1)} points at n = ${nPer} per arm`);
  // The stopping rule is a FIXED resolution target, not the spread currently
  // observed. Chasing the observed spread is unbounded: as n grows the spread
  // shrinks toward zero, so the "n needed to resolve it" grows without limit and
  // the run never ends. The target is GhostKey's published +/-13 points.
  const TARGET = 0.13;
  const need = Math.ceil((z * z * 2 * pbar * (1 - pbar)) / (TARGET * TARGET));
  console.log(`target resolution      : +/-13.0 points, needs ${need} per arm (${Math.max(0, need - nPer)} more)`);
  console.log(
    `
verdict: ${
      chiP(yates) < 0.05
        ? "A DIFFERENCE IS DETECTED — investigate before publishing anything"
        : nPer >= need
          ? "no difference detected, at the target resolution — publishable"
          : "no difference detected, but not yet at the target resolution"
    }`,
  );
}
