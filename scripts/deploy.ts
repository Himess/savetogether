/**
 * Deploys the pool, its token, and the yield source the prizes come from.
 *
 * Uses the real `ConfidentialPrizePool`, not the harness: the harness exists so
 * CI can reveal a draw without the KMS, and it has no business on the address a
 * judge visits.
 *
 * The token is `ERC7984Mock` rather than Zama's deployed cUSDC, and that is a
 * deliberate trade with a cost worth naming. The mock has a public `mint`, so a
 * judge can fund themselves in one click; wiring the real cUSDC would mean
 * minting the underlying, approving, and wrapping before anything happens, and
 * E1 measured what that path does when a precondition is missing — a bare
 * `execution reverted` with no reason attached. `ZamaVaultSource` proves the
 * production path separately, on chain.
 *
 * NOTHING FUNDS THE RESERVE BY HAND. That was the previous deploy's mistake and
 * it made the product a lottery with a pre-funded pot. The reserve fills from
 * `harvest()` alone, so if a prize is paid it came from yield.
 *
 *   npx hardhat run scripts/deploy.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PRIZE = 25n;

/**
 * A demo rate, and openly one: 1000% a year.
 *
 * Chosen so a three-minute recording shows yield actually accruing rather than
 * rounding to zero. At the demo's ~2.1M of deposits it produces roughly 120 in
 * three minutes, which is about five prizes. The mechanism is real — yield is
 * `principal x rate x elapsed` on the encrypted principal — only the number is
 * theatrical, and the README says so.
 */
const RATE_BPS = 100_000n;

/**
 * The shortest a draw window may be, and deliberately equal to the cadence the
 * keeper actually runs at (scripts/keeper.ts PERIOD_SECONDS).
 *
 * Setting the floor to the intended period is the whole point: grinding then
 * gains nothing over the schedule. A floor shorter than the schedule would leave
 * the hole half-open; one longer would stop the keeper doing its job.
 */
const MIN_PERIOD = 300n;

/** The pot the mock pays out of. Simulated, and labelled everywhere as such. */
const POT = 50_000_000n;

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log(`deployer ${me}`);
  console.log(`balance  ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH\n`);

  const Token = await ethers.getContractFactory("ERC7984Mock");
  const token = await Token.deploy("Ghost USDC", "gUSDC", "");
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log(`token   ${tokenAddr}`);

  const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
  const pool = await Pool.deploy(tokenAddr, MIN_PERIOD);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`pool    ${poolAddr}`);

  const Source = await ethers.getContractFactory("MockYieldSource");
  const source = await Source.deploy(tokenAddr, RATE_BPS, poolAddr);
  await source.waitForDeployment();
  const srcAddr = await source.getAddress();
  console.log(`yield   ${srcAddr}  (${Number(RATE_BPS) / 100}% a year)`);

  await (await pool.setYieldSource(srcAddr)).wait();
  await (await pool.setPrize(PRIZE)).wait();
  await (await token.mint(srcAddr, POT)).wait();
  console.log(`\nwired, prize ${PRIZE}, pot ${POT}`);
  console.log(`reserve starts EMPTY — it fills from harvest() and nowhere else`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    pool: poolAddr,
    token: tokenAddr,
    yieldSource: srcAddr,
    rateBps: RATE_BPS.toString(),
    prize: PRIZE.toString(),
    deployer: me,
    block: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));

  console.log(`\nwritten to out/deployment.json`);
  console.log(`\nfrontend:  NEXT_PUBLIC_POOL=${poolAddr}`);
  console.log(`           NEXT_PUBLIC_TOKEN=${tokenAddr}`);
  console.log(`keeper:    POOL=${poolAddr} npm run keeper`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
