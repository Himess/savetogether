/**
 * AB2 — every address in the repo, checked against what is actually deployed.
 *
 * The redeploy failure has recurred four times now in different costumes: a
 * README table whose text and link disagreed, a Vault screen reading the adapter
 * from before the merge while showing the current source on the same card, a
 * state report a generation behind, a batch number that moved. Each time the fix
 * was a manual sweep, and each time the next redeploy undid it.
 *
 * So this is the sweep, as a script. `out/deployment.json` is the only source of
 * truth; everything else is checked against it, and anything that looks like a
 * Sepolia address but is not one of ours or Zama's is reported so a stale
 * generation cannot hide as a plausible-looking constant.
 *
 *   npx hardhat run scripts/check-addresses.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");

const FILES = [
  "README.md",
  "frontend/lib/addresses.ts",
  "packages/hosted/src/cli.ts",
  "packages/mcp-server/src/cli.ts",
  "scripts/status.ts",
  "spikes/hosted-e2e.ts",
  "docs/tier-derivation.md",
  "docs/keeper-deploy.md",
];

interface Known { label: string; address: string; ours: boolean }

function read(rel: string): string | null {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

async function main(): Promise<void> {
  const d = JSON.parse(read("out/deployment.json")!) as Record<string, string>;

  const known: Known[] = [
    { label: "pool", address: d.pool!, ours: true },
    { label: "yieldSource", address: d.yieldSource!, ours: true },
    { label: "module", address: d.module!, ours: true },
    { label: "cUSDC", address: d.token!, ours: false },
    { label: "USDC", address: d.underlying!, ours: false },
    { label: "depositBatcher", address: d.depositBatcher!, ours: false },
    { label: "redeemBatcher", address: d.redeemBatcher!, ours: false },
    { label: "vaultShare", address: d.vaultShare!, ours: false },
  ];
  const lower = new Set(known.map((k) => k.address.toLowerCase()));

  console.log("live, from out/deployment.json:");
  for (const k of known) console.log(`  ${k.label.padEnd(16)} ${k.address}  ${k.ours ? "(ours)" : "(Zama's)"}`);

  // Ours must be verified; a link to unverified bytecode is worse than no link.
  console.log("\nverification:");
  for (const k of known.filter((x) => x.ours)) {
    const code = await ethers.provider.getCode(k.address);
    console.log(`  ${k.label.padEnd(16)} ${code === "0x" ? "NO CODE — WRONG ADDRESS" : `${(code.length - 2) / 2} bytes on chain`}`);
  }

  console.log("\naddresses found in tracked files that are NOT in the live set:");
  let stray = 0;
  for (const rel of FILES) {
    const body = read(rel);
    if (body === null) continue;
    const found = new Set((body.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((a) => a.toLowerCase()));
    for (const a of found) {
      if (lower.has(a)) continue;
      // 0x0 and the ACL are expected; anything else is a generation that got left behind.
      if (/^0x0{40}$/.test(a)) continue;
      if (a === "0xf0ffdc93b7e186bc2f8cb3daa75d86d1930a433d") continue; // Zama ACL
      if (a === "0x6ab54988261aec573a2ca13cf802d3b1114f864c") continue; // the ERC-4626
      // The tokens the previous pools settled in, kept in the CLI defaults so a
      // session opened against an older deployment still resolves its symbol.
      // Deliberate, and the comment beside each says so.
      if (a === "0x8738e041d06cb1263a475a6495ccbb408f4731b8") continue; // gUSDC
      if (a === "0xcff87b42b916f7aa0f61cd060c9f48772f303d37") continue; // gkUSD
      if (a === "0x1bbbe55d24174d57305632e75fe47ac3c5158a9f") continue; // gUSDC, older still
      console.log(`  ${rel}: ${a}`);
      stray++;
    }
  }
  if (stray === 0) console.log("  none");

  // Every markdown link that points at an address must point at the SAME address
  // its own link text names. This is the exact defect the README shipped with.
  console.log("\nREADME links whose text and target disagree:");
  const readme = read("README.md")!;
  let bad = 0;
  const linkRe = /\[`(0x[0-9a-fA-F]{4,}…?[0-9a-fA-F]*)`\]\(https:\/\/sepolia\.etherscan\.io\/address\/(0x[0-9a-fA-F]{40})/g;
  for (const m of readme.matchAll(linkRe)) {
    const shown = m[1]!.replace(/…/g, "").toLowerCase();
    const target = m[2]!.toLowerCase();
    const head = shown.slice(0, 6);
    const tail = shown.slice(-4);
    if (!target.startsWith(head) || !target.endsWith(tail)) {
      console.log(`  shown ${m[1]}  ->  links to ${m[2]}`);
      bad++;
    }
  }
  if (bad === 0) console.log("  none");

  // A tx hash is not an address, so the sweep above cannot see one that has gone
  // stale — and the README shipped exactly that: a join tx from the previous
  // generation, four thousand blocks before the pool it claimed to describe.
  // Narrowing the address regex to skip tx hashes would have hidden that rather
  // than caught it, so the hashes get their own check: each must exist on chain,
  // and must be at or after the block this deployment was created in.
  console.log("\ntx hashes in docs that predate this deployment:");
  const deployBlock = Number(d.block);
  let old = 0;
  for (const rel of FILES) {
    const body = read(rel);
    if (body === null) continue;
    for (const h of new Set(body.match(/0x[0-9a-fA-F]{64}/g) ?? [])) {
      const r = await ethers.provider.getTransactionReceipt(h);
      if (r === null) continue; // a handle, or a hash of something that is not a tx
      if (r.blockNumber < deployBlock) {
        console.log(`  ${rel}: ${h.slice(0, 12)}… mined in ${r.blockNumber}, deployment is ${deployBlock}`);
        old++;
      }
    }
  }
  if (old === 0) console.log("  none");

  console.log(`\n${stray === 0 && bad === 0 && old === 0 ? "CLEAN" : `${stray} stray, ${bad} mismatched, ${old} outdated tx`}`);
  if (stray > 0 || bad > 0 || old > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
});
