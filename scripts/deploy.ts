/**
 * Deploys the pool for the live demo.
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
 * `execution reverted` with no reason attached. The deposit screen supports the
 * real path too; the demo does not put it in front of a first-time visitor.
 *
 *   npx hardhat run scripts/deploy.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PRIZE = 25n; // per winner, in token units
const RESERVE = 10_000n; // covers 400 winners — far past the tail in findings.md §5.4

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
  console.log(`token    ${tokenAddr}`);

  const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
  const pool = await Pool.deploy(tokenAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`pool     ${poolAddr}`);

  await (await pool.setPrize(PRIZE)).wait();
  console.log(`prize    ${PRIZE}`);

  // The reserve is what prizes are paid from. It is funded by an ordinary
  // deposit path, so it is encrypted like everything else — its size is a claim
  // about the pool and not something an observer is entitled to.
  await (await token.mint(me, RESERVE * 2n)).wait();
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await token.setOperator(poolAddr, now + 365 * 24 * 3600)).wait();
  const enc = await fhevm.createEncryptedInput(poolAddr, me).add64(RESERVE).encrypt();
  await (await pool.fundReserve(enc.handles[0]!, enc.inputProof)).wait();
  console.log(`reserve  funded (encrypted)`);

  const out = {
    network: "sepolia",
    chainId: 11155111,
    pool: poolAddr,
    token: tokenAddr,
    prize: PRIZE.toString(),
    deployer: me,
    block: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(out, null, 2));

  console.log(`\nwritten to out/deployment.json`);
  console.log(`\nfrontend:  NEXT_PUBLIC_POOL=${poolAddr}`);
  console.log(`keeper:    POOL=${poolAddr} npm run keeper`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
