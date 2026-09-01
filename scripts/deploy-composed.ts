/**
 * The composed stack: the pool on Zama's own cUSDC, earning through a replica
 * of Steakhouse Confidential Prime that is genuinely wired to Zama's vault.
 *
 * WHY THIS REPLACES scripts/deploy.ts AS THE PRODUCT DEPLOYMENT. The previous
 * arrangement had two yield sources and used the wrong one: a mock that paid,
 * and a vault adapter that composed with Zama's deployed vault but earned
 * nothing, sitting beside the pool unused. So the pool was never actually
 * connected to the vault layer — which is the one claim the narrative rests on.
 *
 * `SteakhouseReplicaSource` merges them. Principal supplied by the pool can be
 * pushed into Zama's real deposit batcher (`joinVault`), and the yield that
 * funds prizes is the replica's own rate. Both halves are labelled everywhere
 * they are shown: the composition is real, the rate is ours.
 *
 * THE TOKEN HAD TO CHANGE and that is the whole reason this is a redeploy rather
 * than a `setYieldSource` call. Zama's batcher takes cUSDC — checked on chain,
 * `adapter.asset()` is 0x7c5BF43B — so a pool settling in our own gUSDC could
 * never join a batch. The pool therefore settles in cUSDC, which is also the
 * token the mainnet story is about.
 *
 *   npx hardhat run scripts/deploy-composed.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Zama's deployed confidential USDC and the vault's deposit batcher. */
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b";

const UNIT = 1_000_000n; // cUSDC is 6 decimals and the wrapper is 1:1

/** 25 USDC a winner. Real units, because the token is a real one. */
const PRIZE = 25n * UNIT;

/** The replica's rate: 1000% a year, theatrical on purpose and labelled so. */
const RATE_BPS = 100_000n;

/** Matches the keeper's cadence, so grinding gains nothing over the schedule. */
const MIN_PERIOD = 300n;

/**
 * The pot the replica pays its yield from.
 *
 * Wrapped rather than minted: cUSDC is a wrapper with no mint of its own, and
 * the underlying's faucet is capped between 1M and 10M per call — measured.
 */
const POT = 900_000n * UNIT;

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function underlying() view returns (address)",
];
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log(`deployer ${me}`);
  console.log(`balance  ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH\n`);

  // Assert the wrapper is what we think before building on it.
  const wrapper = new ethers.Contract(CUSDC, WRAPPER_ABI, signer);
  const underlying: string = await wrapper.underlying!();
  if (underlying.toLowerCase() !== USDC.toLowerCase()) {
    throw new Error(`cUSDC.underlying() is ${underlying}, not the USDC we mint from`);
  }
  console.log(`token    ${CUSDC}  (Zama's cUSDC, underlying ${underlying})`);

  const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
  const pool = await Pool.deploy(CUSDC, MIN_PERIOD);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`pool     ${poolAddr}`);

  const Source = await ethers.getContractFactory("SteakhouseReplicaSource");
  const source = await Source.deploy(CUSDC, DEPOSIT_BATCHER, RATE_BPS, poolAddr);
  await source.waitForDeployment();
  const srcAddr = await source.getAddress();
  console.log(`replica  ${srcAddr}  (${Number(RATE_BPS) / 100}% a year, wired to the vault)`);

  await (await pool.setYieldSource!(srcAddr)).wait();
  await (await pool.setPrize!(PRIZE)).wait();

  console.log(`\nfunding the replica's pot: mint ${POT / UNIT} USDC, approve, wrap to the source`);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, signer);
  await (await usdc.mint!(me, POT)).wait();
  await (await usdc.approve!(CUSDC, POT)).wait();
  await (await wrapper.wrap!(srcAddr, POT)).wait();

  console.log(`\nprize    ${PRIZE / UNIT} USDC`);
  console.log(`period   ${MIN_PERIOD}s floor`);
  console.log(`reserve  starts EMPTY — it fills from harvest() and nowhere else`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    note: "the pool on Zama's cUSDC, earning through a Steakhouse replica wired to Zama's vault",
    pool: poolAddr,
    token: CUSDC,
    underlying: USDC,
    yieldSource: srcAddr,
    depositBatcher: DEPOSIT_BATCHER,
    decimals: 6,
    rateBps: RATE_BPS.toString(),
    prize: PRIZE.toString(),
    minPeriod: MIN_PERIOD.toString(),
    pot: POT.toString(),
    deployer: me,
    block: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));
  console.log(`\nwritten to out/deployment.json`);
  console.log(`\nfrontend:  NEXT_PUBLIC_POOL=${poolAddr}`);
  console.log(`           NEXT_PUBLIC_TOKEN=${CUSDC}`);
  console.log(`keeper:    POOL=${poolAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
