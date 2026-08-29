/**
 * Does the pool actually work on Zama's wrapper, rather than only on our mock?
 *
 * Everything else is theory until a deposit lands. The pool holds an ERC-7984
 * and never asks which one, but "never asks" is a claim about our code, not
 * about the wrapper's -- and the wrapper is somebody else's contract with its own
 * operator model, its own error surface and its own idea of what a zero balance
 * means. So: wrap, authorise, deposit, read it back.
 *
 * The assertion is on the DELTA, not the absolute position. An absolute check
 * passes once on a virgin pool and then reports a perfectly good deposit as a
 * failure on every run afterwards, which is how the first version of this script
 * cried wolf three times in a row.
 *
 *   npx hardhat run scripts/smoke-cusdc.ts --network sepolia
 */
import { FhevmType } from "@fhevm/hardhat-plugin";
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const AMOUNT = 100n * 1_000_000n; // 100 USDC

async function main(): Promise<void> {
  await fhevm.initializeCLIApi();
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "out", "deployment-cusdc.json"), "utf8"),
  );
  console.log(`pool  ${d.pool}`);
  console.log(`token ${d.token}  (Zama's cUSDC)\n`);

  const usdc = new ethers.Contract(
    d.underlying,
    ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"],
    signer,
  );
  const cusdc = new ethers.Contract(
    d.token,
    [
      "function wrap(address to, uint256 amount) returns (bytes32)",
      "function isOperator(address,address) view returns (bool)",
      "function setOperator(address,uint48)",
    ],
    signer,
  );
  const pool = new ethers.Contract(
    d.pool,
    [
      "function deposit(bytes32,bytes)",
      "function confidentialBalanceOf(address) view returns (bytes32)",
    ],
    signer,
  );

  const read = async (): Promise<bigint> => {
    const h: string = await pool.confidentialBalanceOf!(me);
    if (h === ethers.ZeroHash) return 0n;
    return await fhevm.userDecryptEuint(FhevmType.euint64, h, d.pool, signer);
  };

  const before = await read();
  console.log(`0. position before   ${before} (${Number(before) / 1e6} USDC)`);

  console.log("1. mint underlying, approve, wrap");
  await (await usdc.mint!(me, AMOUNT)).wait();
  await (await usdc.approve!(d.token, AMOUNT)).wait();
  await (await cusdc.wrap!(me, AMOUNT)).wait();
  console.log(`   wrapped ${AMOUNT / 1_000_000n} USDC`);

  console.log("2. authorise the pool as an operator of my cUSDC");
  if (!(await cusdc.isOperator!(me, d.pool))) {
    await (await cusdc.setOperator!(d.pool, Math.floor(Date.now() / 1000) + 86_400)).wait();
  }
  console.log("   operator set");

  console.log("3. deposit");
  const enc = await fhevm.createEncryptedInput(d.pool, me).add64(AMOUNT).encrypt();
  const tx = await pool.deposit!(enc.handles[0], enc.inputProof);
  const rc = await tx.wait();
  console.log(`   ${tx.hash}`);
  console.log(`   gas ${rc.gasUsed}`);

  console.log("4. read the position back, decrypted");
  const after = await read();
  const moved = after - before;
  console.log(`   position after   ${after} (${Number(after) / 1e6} USDC)`);
  console.log(`   delta            ${moved}`);

  if (moved === AMOUNT) {
    console.log(
      `\nPASS - the deposit moved exactly ${AMOUNT / 1_000_000n} USDC of Zama's own ` +
        `confidential USDC into the pool.`,
    );
  } else {
    console.log(`\nFAIL - deposited ${AMOUNT} but the position moved by ${moved}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
