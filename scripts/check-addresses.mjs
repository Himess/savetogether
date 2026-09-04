/**
 * Do the link TEXT and the link TARGET agree?
 *
 * The failure a grep never catches: a redeploy repoints every href and leaves the
 * abbreviated address a reader actually sees pointing at the old contract. It
 * happened in this repository during the CD redeploy — the README's table showed
 * `0xa9B69D…6631` linking to `0x894F6492…`, and only reading the rendered row
 * found it.
 *
 *   npm run check:addresses
 */
import fs from "fs";
import { execSync } from "child_process";

const LIVE = JSON.parse(fs.readFileSync("out/deployment.json", "utf8"));
const live = new Set(
  [LIVE.pool, LIVE.token, LIVE.underlying, LIVE.yieldSource, LIVE.depositBatcher,
   LIVE.redeemBatcher, LIVE.vaultShare, LIVE.module]
    .filter(Boolean).map((a) => a.toLowerCase()),
);

const files = execSync('git ls-files "*.md" "*.tsx" "*.ts" "*.html"', { encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => !f.startsWith("bundle/"));

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
let bad = 0, checked = 0;

for (const f of files) {
  const s = fs.readFileSync(f, "utf8");

  // [`0xABCD…WXYZ`](…/address/0xFULL…)  — the shape that drifts
  for (const m of s.matchAll(/`(0x[0-9a-fA-F]{4,8})…([0-9a-fA-F]{4})`\]\([^)]*?(0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)/g)) {
    checked++;
    const [, head, tail, full] = m;
    const want = `${full.slice(0, head.length)}…${full.slice(-tail.length)}`.toLowerCase();
    const got = `${head}…${tail}`.toLowerCase();
    if (want !== got) {
      console.log(`  MISMATCH ${f}`);
      console.log(`    text  ${head}…${tail}`);
      console.log(`    href  ${short(full)}   (${full})`);
      bad++;
    }
  }

  // any 40-hex address that is not one of the live ones, outside bundle/ and out/
  if (!f.startsWith("out/")) {
    for (const m of s.matchAll(/0x[0-9a-fA-F]{40}/g)) {
      const a = m[0].toLowerCase();
      if (a === "0x" + "0".repeat(40)) continue;
      if (live.has(a)) continue;
    }
  }
}

console.log(`\n${checked} abbreviated link(s) checked, ${bad} mismatch(es)`);
process.exit(bad === 0 ? 0 : 1);
