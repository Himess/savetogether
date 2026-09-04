/**
 * Which out/ artifacts are safe to commit?
 *
 * An ALLOWLIST, not a denylist. out/ holds evidence and it also holds live private
 * keys — demo-participants.json is a bare array of them, and arms-c.json carries
 * them under `arms[].pk` controlling funded accounts. Neither was ever committed,
 * because out/ has always been ignored. That protection stays; this only lifts it
 * for named files, and every one is re-checked here before it is named.
 */
import fs from "fs";

const NEVER = new Set(["demo-participants.json", "arms-c.json"]);

const hexPaths = (o, path, out) => {
  if (typeof o === "string") { if (/^(0x)?[0-9a-fA-F]{64}$/.test(o)) out.push(path || "(bare)"); return; }
  if (Array.isArray(o)) return o.forEach((v) => hexPaths(v, path ? path + "[]" : "[]", out));
  if (o && typeof o === "object") return Object.entries(o).forEach(([k, v]) => hexPaths(v, path ? path + "." + k : k, out));
};

const safe = [];
for (const f of fs.readdirSync("out").sort()) {
  if (f === "shots") continue;
  if (NEVER.has(f)) { console.log(`  SKIP (holds keys)   ${f}`); continue; }
  if (!f.endsWith(".json")) { safe.push(f); continue; }
  const paths = [];
  try { hexPaths(JSON.parse(fs.readFileSync("out/" + f, "utf8")), "", paths); }
  catch { console.log(`  SKIP (unparseable)  ${f}`); continue; }
  const bad = [...new Set(paths)].filter((p) => /^\[\]$|\(bare\)|key$|\bpk\b|secret|priv|mnemonic/i.test(p));
  if (bad.length) { console.log(`  SKIP (key-shaped: ${bad.join(", ")})  ${f}`); continue; }
  safe.push(f);
}

console.log(`\n${safe.length} artifact(s) cleared to commit`);
fs.writeFileSync(".safe-out.json", JSON.stringify(safe, null, 1));
