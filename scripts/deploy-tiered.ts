/**
 * Phase D — the tiered pool, one deploy.
 *
 * Everything Phase B justified lands here at once. Separately would mean four
 * deployments and four re-measurements of a surface that has to be measured as a
 * whole.
 *
 *   npx hardhat run scripts/deploy-tiered.ts --network sepolia
 *
 * STOP THE KEEPER FIRST. It signs with the same key and will race for nonces.
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b";

const U = 1_000_000n;

/**
 * The derived shape. See `docs/tier-derivation.md` and the README.
 *
 * At 12,401 cUSDC of principal and 1000%/yr over 1800s rounds the harvest is
 * 7.0782 cUSDC. Expected payout is `25/100 + 5/10 + 1 = 1.75`, so utilisation is
 * 24.7% and the surplus is the variance buffer a single reserve needs to absorb
 * a prize that fires once every hundred draws. Simulated over 20,000 trials the
 * clamp risk is 3.2-3.6%, concentrated entirely in the first four rounds.
 */
const TIER_PRIZES: [bigint, bigint, bigint] = [25n * U, 5n * U, 1n * U];
const TIER_K: [bigint, bigint, bigint] = [100n, 10n, 1n];

const RATE_BPS = 100_000n;
const MIN_PERIOD = 300n;

/** What one accrueMany call pays its caller. ~1/5 of the ordinary prize. */
const KEEPER_FEE = 200_000n;

/** The replica's pot. Wrapped, because cUSDC has no mint of its own. */
const POT = 900_000n * U;

/** Seed principal, so the pool is not empty on arrival. */
const SEED = 12_000n * U;

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function underlying() view returns (address)",
  "function setOperator(address operator, uint48 until)",
];
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer!.getAddress();
  const balance = await ethers.provider.getBalance(me);
  console.log(`deployer ${me}`);
  console.log(`balance  ${ethers.formatEther(balance)} ETH\n`);
  if (balance < ethers.parseEther("0.05")) throw new Error("fund the deployer first");

  const wrapper = new ethers.Contract(CUSDC, WRAPPER_ABI, signer!);
  if ((await wrapper.underlying!()).toLowerCase() !== USDC.toLowerCase()) {
    throw new Error("cUSDC.underlying() is not the USDC we mint from");
  }

  const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
  const pool = await Pool.deploy(CUSDC, MIN_PERIOD);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`pool     ${poolAddr}`);

  const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
  const source = await Source.deploy(CUSDC, DEPOSIT_BATCHER, RATE_BPS, poolAddr);
  await source.waitForDeployment();
  const srcAddr = await source.getAddress();
  console.log(`source   ${srcAddr}  (${Number(RATE_BPS) / 100}% a year, bounded joinVault)`);

  await (await pool.setYieldSource!(srcAddr)).wait();
  await (await pool.setTiers!(TIER_PRIZES, TIER_K)).wait();
  await (await pool.setKeeperFee!(KEEPER_FEE)).wait();
  console.log(`\ntiers    prizes ${TIER_PRIZES.map((p) => Number(p) / 1e6).join(" / ")} cUSDC`);
  console.log(`         k      ${TIER_K.join(" / ")}   (one winner every k draws)`);
  console.log(`keeper   ${Number(KEEPER_FEE) / 1e6} cUSDC per accrueMany, taken after every prize`);

  console.log(`\nfunding the pot: mint ${POT / U}, approve, wrap to the source`);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, signer!);
  await (await usdc.mint!(me, POT)).wait();
  await (await usdc.approve!(CUSDC, POT)).wait();
  await (await wrapper.wrap!(srcAddr, POT)).wait();

  console.log(`seeding principal: ${SEED / U} cUSDC`);
  await (await usdc.mint!(me, SEED)).wait();
  await (await usdc.approve!(CUSDC, SEED)).wait();
  await (await wrapper.wrap!(me, SEED)).wait();
  await (await wrapper.setOperator!(poolAddr, Math.floor(Date.now() / 1000) + 365 * 24 * 3600)).wait();
  const enc = await fhevm.createEncryptedInput(poolAddr, me).add64(SEED).encrypt();
  await (await pool.deposit!(enc.handles[0], enc.inputProof)).wait();

  const harvest = (SEED * RATE_BPS * 1800n) / (10_000n * 31_536_000n);
  const expected = TIER_PRIZES.reduce((a, p, i) => a + p / TIER_K[i]!, 0n);
  console.log(`\nharvest  ${Number(harvest) / 1e6} cUSDC per 1800s round`);
  console.log(`expected ${Number(expected) / 1e6} cUSDC of payout per round  (${((Number(expected) / Number(harvest)) * 100).toFixed(1)}% utilisation)`);
  console.log(`reserve  starts EMPTY — it fills from harvest() and nowhere else`);
  console.log(`\nWARM-UP: the first ~4 rounds carry a 3.2-3.6% chance a grand prize`);
  console.log(`         cannot be covered. Let the keeper run past round 10 before`);
  console.log(`         recording anything. Do NOT pre-fund the reserve.`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    note: "tiered pool on Zama's cUSDC, earning through a Steakhouse replica wired into Zama's vault",
    pool: poolAddr,
    token: CUSDC,
    tokenSymbol: "cUSDC",
    decimals: 6,
    underlying: USDC,
    yieldSource: srcAddr,
    yieldSourceKind: "SteakhouseReplicaSource",
    depositBatcher: DEPOSIT_BATCHER,
    vaultShare: "0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4",
    module: "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6",
    rateBps: RATE_BPS.toString(),
    tierPrizes: TIER_PRIZES.map(String),
    tierK: TIER_K.map(String),
    keeperFee: KEEPER_FEE.toString(),
    minPeriod: MIN_PERIOD.toString(),
    pot: POT.toString(),
    seedPrincipal: SEED.toString(),
    deployer: me,
    block: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));
  console.log(`\nwritten to out/deployment.json`);
  console.log(`\nfrontend:  NEXT_PUBLIC_POOL=${poolAddr}`);
  console.log(`keeper:    POOL=${poolAddr}`);
}

main().catch((e) => {
  console.error(String(e).split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
});
