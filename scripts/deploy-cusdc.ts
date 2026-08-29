/**
 * The same pool, on Zama's own confidential USDC.
 *
 * `scripts/deploy.ts` deploys onto `ERC7984Mock` because it has a public `mint`
 * and a judge can fund themselves in one click. That is a real convenience and
 * it is also the weakest part of the story: the submission's claim is that
 * Zama's ecosystem already has the confidential token layer and what is missing
 * is what a deposit can DO with it. A pool that only runs on a token we minted
 * ourselves does not demonstrate that.
 *
 * Nothing in `ConfidentialPrizePool` changes. It holds an ERC-7984 and never
 * asks which one, and both measurements that mattered were checked against this
 * exact wrapper before this script existed: D1 found the deployed cUSDC CLAMPS an
 * insufficient transfer rather than reverting, which is the assumption the silent
 * withdraw rests on, and E1 found mint -> approve -> wrap succeeds from an account
 * the wrapper has never seen.
 *
 * The pot is the one thing that genuinely differs. cUSDC has no public mint --
 * it is a wrapper -- so the yield source is funded by minting the underlying,
 * approving, and wrapping DIRECTLY to the source's address. The underlying's
 * mint is permissionless but capped: 1,000,000 USDC per call succeeds and
 * 10,000,000 reverts, so the pot is sized under that ceiling rather than at the
 * 50,000,000 the mock pool uses.
 *
 *   npx hardhat run scripts/deploy-cusdc.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Zama's staging deployment. `underlying()` and `rate()` were read on chain. */
const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";

const UNIT = 1_000_000n; // cUSDC is 6 decimals, and wraps 1:1

/** 25 USDC. Real units this time, because the token is a real one. */
const PRIZE = 25n * UNIT;

/** 1000% a year, and labelled as theatrical everywhere it is shown. */
const RATE_BPS = 100_000n;

/** 250,000 USDC, comfortably under the underlying's per-call mint ceiling. */
const POT = 250_000n * UNIT;

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function underlying() view returns (address)",
  "function rate() view returns (uint256)",
];

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log(`deployer ${me}`);
  console.log(`balance  ${ethers.formatEther(await ethers.provider.getBalance(me))} ETH\n`);

  // Assert the wrapper is what we think it is before deploying against it.
  const wrapper = new ethers.Contract(CUSDC, WRAPPER_ABI, signer);
  const underlyingAddr: string = await wrapper.underlying!();
  if (underlyingAddr.toLowerCase() !== USDC.toLowerCase()) {
    throw new Error(`cUSDC.underlying() is ${underlyingAddr}, not the USDC mock we mint from`);
  }
  console.log(`wrapper  ${CUSDC}  (underlying ${underlyingAddr}, rate ${await wrapper.rate!()})`);

  const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
  const pool = await Pool.deploy(CUSDC);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`pool     ${poolAddr}`);

  const Source = await ethers.getContractFactory("MockYieldSource");
  const source = await Source.deploy(CUSDC, RATE_BPS, poolAddr);
  await source.waitForDeployment();
  const srcAddr = await source.getAddress();
  console.log(`yield    ${srcAddr}  (${Number(RATE_BPS) / 100}% a year)`);

  await (await pool.setYieldSource!(srcAddr)).wait();
  await (await pool.setPrize!(PRIZE)).wait();

  // The pot: mint the underlying, approve the wrapper, wrap straight to the
  // source. There is no mint on a wrapper, so this is the only way to create one.
  const underlying = new ethers.Contract(USDC, ERC20_ABI, signer);
  await (await underlying.mint!(me, POT)).wait();
  await (await underlying.approve!(CUSDC, POT)).wait();
  await (await wrapper.wrap!(srcAddr, POT)).wait();
  console.log(`\npot      ${POT / UNIT} USDC wrapped into the yield source`);
  console.log(`prize    ${PRIZE / UNIT} USDC`);
  console.log(`reserve  starts EMPTY — it fills from harvest() and nowhere else`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    note: "the pool on Zama's deployed confidential USDC",
    pool: poolAddr,
    token: CUSDC,
    underlying: USDC,
    yieldSource: srcAddr,
    decimals: 6,
    rateBps: RATE_BPS.toString(),
    prize: PRIZE.toString(),
    pot: POT.toString(),
    deployer: me,
    block: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment-cusdc.json"), JSON.stringify(out, null, 2));
  console.log(`\nwritten to out/deployment-cusdc.json`);
  console.log(`\nghostkey init --pool ${poolAddr} --pool-token cUSDC`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
