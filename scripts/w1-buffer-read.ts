/**
 * W1, answered without spending gas.
 *
 * The source's confidential balance is its own handle and nobody else may
 * decrypt it — correctly. But the number that matters is reconstructable from
 * PUBLIC data, because wrapping is a public act: every cUSDC in this system
 * arrived as a public ERC-20 transfer into the wrapper, and the deposits are
 * amounts this deployer chose and can state.
 *
 *   npx hardhat run scripts/w1-buffer-read.ts --network sepolia
 *
 * Read-only. Sends nothing.
 */
import { ethers } from "hardhat";

const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const SRC = "0x15331b79E80EF6606a1aD4C0b13F7EA49482e8A5";
const U = 1_000_000n;

const fmt = (v: bigint): string => (Number(v) / 1e6).toLocaleString("en-US") + " cUSDC";

async function main(): Promise<void> {
  const [s] = await ethers.getSigners();
  const me = await s!.getAddress();

  // Wrapping mints cUSDC against a public ERC-20 transfer into the wrapper, so
  // the pot is visible even though the balance it became is not.
  const usdc = new ethers.Contract(
    USDC,
    ["event Transfer(address indexed from, address indexed to, uint256 value)"],
    ethers.provider,
  );
  const deployBlock = 11_600_000;
  const latest = await ethers.provider.getBlockNumber();

  let total = 0n;
  const found: { block: number; value: bigint }[] = [];
  const STEP = 9_000;
  for (let from = deployBlock; from <= latest; from += STEP) {
    const to = Math.min(from + STEP - 1, latest);
    const logs = await usdc.queryFilter(usdc.filters.Transfer!(me, CUSDC), from, to);
    for (const l of logs) {
      const v = (l as unknown as { args: { value: bigint } }).args.value;
      total += v;
      found.push({ block: l.blockNumber, value: v });
    }
  }

  console.log(`public USDC wrapped into cUSDC by this deployer`);
  for (const f of found) console.log(`  block ${f.block}  ${fmt(f.value)}`);
  console.log(`  total ${fmt(total)}\n`);

  const src = await ethers.getContractAt("SteakhouseReplicaSource", SRC, s!);
  const joined = await src.openBatches!();
  console.log(`the source's open vault batches: [${joined.join(", ")}]`);
  console.log(`rate ${Number(await src.rateBps!()) / 100}% a year`);
  console.log(`last settled ${new Date(Number(await src.lastAccrual!()) * 1000).toISOString()}`);
  console.log(`principal handle initialised: ${(await src.principal!()) !== ethers.ZeroHash}`);
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 3).join("\n"));
  process.exitCode = 1;
});
