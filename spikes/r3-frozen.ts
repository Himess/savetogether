/**
 * R3 — does a fractional deposit path disturb the frozen surface?
 *
 * `accrue`, `_snapshotCumulative`, `_cumulativeAt`, `thresholdFor`, `_uniform`.
 * The 306-sample equality result depends on these behaving identically, so the
 * question is answered three ways, weakest first:
 *
 *   1. SOURCE   the text of each frozen function, in the baseline and in the
 *               variant, hashed and compared.
 *   2. BYTECODE the whole runtime bytecode of both contracts, to see how much
 *               moved and whether the frozen code survived relocation intact.
 *   3. GAS      `accrue` executed on both, same state, same sequence. This is
 *               the one that matters, because the equality result is a claim
 *               about execution cost rather than about source text.
 *
 *   npx hardhat run spikes/r3-frozen.ts
 */
import { ethers, fhevm } from "hardhat";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const FROZEN = ["accrue", "_snapshotCumulative", "_cumulativeAt", "thresholdFor", "_uniform"];

/** Pulls one function's full text by brace matching from its signature. */
function extractFunction(source: string, name: string): string | null {
  const re = new RegExp(`\\n\\s*function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (m === null) return null;
  let i = source.indexOf("{", m.index);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(m.index, j + 1);
    }
  }
  return null;
}

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

async function main(): Promise<void> {
  const read = (p: string): string => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const baseline = read("contracts/spikes/PoolFrozenBaseline.sol");
  const variant = read("contracts/spikes/PoolWithFraction.sol");

  console.log("1. SOURCE — the frozen functions, hashed\n");
  let sourceClean = true;
  for (const fn of FROZEN) {
    const a = extractFunction(baseline, fn);
    const b = extractFunction(variant, fn);
    if (a === null || b === null) {
      console.log(`   ${fn.padEnd(22)} NOT FOUND (a=${a !== null} b=${b !== null})`);
      sourceClean = false;
      continue;
    }
    const same = a === b;
    if (!same) sourceClean = false;
    console.log(
      `   ${fn.padEnd(22)} ${sha(a)}  ${same ? "identical" : "DIFFERENT"}  ${a.split("\n").length} lines`,
    );
  }
  console.log(`\n   => ${sourceClean ? "no frozen function was touched" : "A FROZEN FUNCTION CHANGED"}\n`);

  console.log("2. BYTECODE — how much of the contract moved\n");
  const art = (n: string): { deployedBytecode: string } =>
    JSON.parse(read(`artifacts/contracts/spikes/${n}.sol/${n}.json`)) as { deployedBytecode: string };
  // Solidity appends a CBOR metadata trailer that encodes the source hash, so it
  // differs between two files whatever their code does. Strip it before comparing.
  const strip = (bc: string): string => {
    const len = parseInt(bc.slice(-4), 16);
    return bc.slice(0, bc.length - (len * 2 + 4));
  };
  const b0 = strip(art("PoolFrozenBaseline").deployedBytecode);
  const b1 = strip(art("PoolWithFraction").deployedBytecode);

  let prefix = 0;
  while (prefix < b0.length && prefix < b1.length && b0[prefix] === b1[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < b0.length - prefix &&
    suffix < b1.length - prefix &&
    b0[b0.length - 1 - suffix] === b1[b1.length - 1 - suffix]
  )
    suffix += 1;

  console.log(`   baseline  ${b0.length / 2} bytes`);
  console.log(`   variant   ${b1.length / 2} bytes  (+${(b1.length - b0.length) / 2})`);
  console.log(`   shared prefix ${prefix / 2} bytes, shared suffix ${suffix / 2} bytes`);
  console.log(
    `   differing middle: ${(b0.length - prefix - suffix) / 2} baseline vs ` +
      `${(b1.length - prefix - suffix) / 2} variant bytes\n`,
  );

  console.log("3. GAS — accrue on both, same state, same sequence\n");
  await fhevm.initializeCLIApi();
  const [deployer, alice, bob] = await ethers.getSigners();

  const results: Record<string, string[]> = {};
  for (const name of ["PoolFrozenBaseline", "PoolWithFraction"]) {
    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("Ghost USDC", "gUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory(name);
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const gas: string[] = [];
    for (const who of [alice, bob]) {
      await (await token.mint!(await who.getAddress(), 1000n)).wait();
      await (
        await token
          .connect(who)
          .setOperator!(poolAddr, Math.floor(Date.now() / 1000) + 86_400)
      ).wait();
      const enc = await fhevm
        .createEncryptedInput(poolAddr, await who.getAddress())
        .add64(100n)
        .encrypt();
      await (
        await pool.connect(who).deposit!(enc.handles[0], enc.inputProof)
      ).wait();
    }

    await (await pool.setPrize!(25n)).wait();
    await (await pool.connect(deployer).openDraw!()).wait();

    for (const who of [alice, bob]) {
      const rc = await (await pool.accrue!(await who.getAddress())).wait();
      gas.push(rc.gasUsed.toString());
    }
    results[name] = gas;
    console.log(`   ${name.padEnd(20)} accrue gas ${gas.join(", ")}`);
  }

  const same =
    JSON.stringify(results["PoolFrozenBaseline"]) === JSON.stringify(results["PoolWithFraction"]);
  console.log(
    `\n   => accrue costs ${same ? "EXACTLY the same" : "DIFFERENT amounts"} in both contracts`,
  );

  const out = { sourceClean, prefixBytes: prefix / 2, suffixBytes: suffix / 2, gas: results, same };
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "r3-frozen.json"), JSON.stringify(out, null, 2));
  console.log("\nwritten to spikes/out/r3-frozen.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
