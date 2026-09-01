/**
 * The filtered diff. Run it before shipping any change to the pool.
 *
 * The 306-sample equality result is the strongest evidence in the submission and
 * it is a claim about five functions behaving identically. Any edit to
 * ConfidentialPrizePool has to prove it did not touch them, and "I only changed
 * something else" is not proof — that is exactly how it would break.
 *
 *   node spikes/frozen-diff.js <baseline.sol> [current.sol]
 */
const fs = require("fs");
const crypto = require("crypto");

const FROZEN = ["accrue", "_snapshotCumulative", "_cumulativeAt", "thresholdFor", "_uniform"];

/** Pulls one function's full text by brace matching from its signature. */
function extract(src, name) {
  const re = new RegExp("\\n\\s*function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (m === null) return null;
  const open = src.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  return null;
}

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

const baselinePath = process.argv[2];
const currentPath = process.argv[3] ?? "contracts/ConfidentialPrizePool.sol";
if (baselinePath === undefined) {
  console.error("usage: node spikes/frozen-diff.js <baseline.sol> [current.sol]");
  process.exit(2);
}

const before = read(baselinePath);
const after = read(currentPath);

console.log("FILTERED SOURCE DIFF — the five frozen functions\n");
let clean = true;
for (const fn of FROZEN) {
  const a = extract(before, fn);
  const b = extract(after, fn);
  if (a === null || b === null) {
    console.log(`  ${fn.padEnd(22)} NOT FOUND (baseline=${a !== null}, current=${b !== null})`);
    clean = false;
    continue;
  }
  const same = a === b;
  if (!same) clean = false;
  console.log(
    `  ${fn.padEnd(22)} ${sha(a)}  ${same ? "identical" : "*** DIFFERENT ***"}  ${a.split("\n").length} lines`,
  );
}

console.log(`\n  => ${clean ? "no frozen function was touched" : "A FROZEN FUNCTION CHANGED — STOP"}`);
process.exit(clean ? 0 : 1);
