/**
 * G2 — the KMS reveal, end to end, on the real contract.
 *
 * This is the largest untested thing in the system. `revealDraw` cannot be
 * exercised locally because it needs real KMS signatures, and A7 lists four traps
 * on this path, every one of which is expensive to find in production:
 *
 *   - `makePubliclyDecryptable` is permanent, and a null handle bricks the machine
 *   - `checkSignatures` carries no replay guard of its own
 *   - the handle list must be rebuilt from storage in the order the off-chain
 *     request used
 *   - the cleartexts decode positionally, so a swapped pair is silently wrong
 *     rather than an error
 *
 * If this does not work there is no draw, no video and no submission. Nothing else
 * on day 4 starts until it passes — in particular not the 412-transaction equality
 * run, which would be spent against a contract that then had to change.
 *
 * The test does not stop at "it reverted or it didn't". It recomputes the
 * threshold off chain from the revealed R and checks that `accrue` awarded the
 * prize exactly when the independent calculation says it should have.
 *
 *   npx hardhat test test/sepolia-reveal.ts --network sepolia
 */
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";
import * as path from "path";

const PRIZE = 5_000n;

/** `_uniform` from the contract, reimplemented so the check is independent. */
function uniform(entropy: bigint, upperBound: bigint): bigint {
  if (upperBound === 0n) return 0n;
  const MAX = (1n << 256n) - 1n;
  const min = (MAX - upperBound + 1n) % upperBound;
  let random = entropy;
  while (random < min) {
    random = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [random])));
  }
  return random % upperBound;
}

describe("KMS reveal, end to end", () => {
  it("reveals a draw and awards it to the account the maths picks", async function () {
    this.timeout(2_400_000);

    await fhevm.initializeCLIApi();
    const [signer] = await ethers.getSigners();
    const me = await signer.getAddress();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // The real contract, not the harness: the whole point is `revealDraw`.
    const Pool = await ethers.getContractFactory("ConfidentialPrizePool");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const addr = await pool.getAddress();
    console.log(`\n    pool  ${addr}`);

    await (await token.mint(me, 10_000_000n)).wait();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await token.setOperator(addr, now + 365 * 24 * 3600)).wait();
    await (await pool.setPrize(PRIZE)).wait();

    let e = await fhevm.createEncryptedInput(addr, me).add64(100_000n).encrypt();
    await (await pool.fundReserve(e.handles[0]!, e.inputProof)).wait();

    e = await fhevm.createEncryptedInput(addr, me).add64(1_000n).encrypt();
    await (await pool.deposit(e.handles[0]!, e.inputProof)).wait();

    // Let some wall clock pass so the window has non-zero weight in it. A draw
    // opened in the same block as the only deposit has a total weight of zero,
    // which would make every threshold zero and prove nothing about the maths.
    e = await fhevm.createEncryptedInput(addr, me).add64(1n).encrypt();
    await (await pool.deposit(e.handles[0]!, e.inputProof)).wait();

    await (await pool.openDraw()).wait();
    const opened = await pool.drawAt(1);
    console.log(`    draw 1 opened, snapshot ${opened.snapshotAt}, status ${opened.status}`);
    expect(opened.encR).to.not.equal(ethers.ZeroHash);
    expect(opened.encTotalWeight).to.not.equal(ethers.ZeroHash);

    // The order here MUST match the contract's handle list. `revealDraw` builds
    // [encR, encTotalWeight]; swapping them decodes into the wrong fields and
    // fails silently rather than loudly.
    console.log(`    requesting public decryption for [encR, encTotalWeight]`);
    const pub = await fhevm.publicDecrypt([opened.encR, opened.encTotalWeight]);

    const tx = await pool.revealDraw(1, pub.abiEncodedClearValues, pub.decryptionProof);
    const receipt = await tx.wait();
    console.log(`    revealDraw mined, gas ${receipt!.gasUsed}`);

    const revealed = await pool.drawAt(1);
    console.log(`    status       ${revealed.status}  (2 = Revealed)`);
    console.log(`    R            ${revealed.r}`);
    console.log(`    totalWeight  ${revealed.totalWeight}`);
    expect(revealed.status).to.equal(2n);
    expect(revealed.totalWeight).to.be.greaterThan(0n);

    // ---- the maths, independently -----------------------------------------
    const onChainThreshold = await pool.thresholdFor(1, me);
    const entropy = BigInt(
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint64", "uint32", "address"],
          [revealed.r, 1, me],
        ),
      ),
    );
    const offChainThreshold = uniform(entropy, revealed.totalWeight);
    console.log(`    threshold on chain  ${onChainThreshold}`);
    console.log(`    threshold off chain ${offChainThreshold}`);
    expect(onChainThreshold).to.equal(offChainThreshold);
    expect(onChainThreshold).to.be.lessThan(revealed.totalWeight);

    await (await pool.weightFor(1, me)).wait();
    const wHandle = await pool.weightFor.staticCall(1, me);
    const weight = await fhevm.userDecryptEuint(FhevmType.euint128, wHandle, addr, signer);
    const shouldWin = weight > onChainThreshold;
    console.log(`    weight       ${weight}`);
    console.log(`    should win   ${shouldWin}`);

    await (await pool.accrue(me, 1)).wait();
    const wonHandle = await pool.winningsOf(me);
    const won =
      wonHandle === ethers.ZeroHash
        ? 0n
        : await fhevm.userDecryptEuint(FhevmType.euint64, wonHandle, addr, signer);
    console.log(`    winnings     ${won}`);

    expect(won).to.equal(shouldWin ? PRIZE : 0n);

    fs.mkdirSync(path.join(__dirname, "..", "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "..", "out", "reveal.json"),
      JSON.stringify(
        {
          pool: addr,
          r: revealed.r.toString(),
          totalWeight: revealed.totalWeight.toString(),
          threshold: onChainThreshold.toString(),
          weight: weight.toString(),
          shouldWin,
          won: won.toString(),
          revealGas: receipt!.gasUsed.toString(),
        },
        null,
        2,
      ),
    );
  });
});
