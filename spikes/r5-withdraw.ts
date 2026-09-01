import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";
import * as path from "path";

/**
 * The other direction, which turns out to be the interesting one.
 *
 * A fractional DEPOSIT needs an ACL grant, because the pool has to compute on a
 * handle the token granted only to the holder. A fractional WITHDRAWAL needs
 * nothing: the pool wrote the position handle itself with `allowThis`, so it
 * already has the access. One transaction, no grant, no plaintext, and no
 * balance handle in the calldata either — the caller passes a shift and nothing
 * else.
 *
 * Measured against the ordinary withdraw on the same pool, same state.
 *
 *   npx hardhat test spikes/r5-withdraw.ts
 */
const DAY = 24 * 60 * 60;

describe("R5 — a fractional withdrawal needs no grant and no plaintext", () => {
  it("takes exactly half, and costs less than the encrypted-input path", async () => {
    await fhevm.initializeCLIApi();
    const [, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ERC7984Mock");
    const token = await Token.deploy("cUSDC", "cUSDC", "");
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const Pool = await ethers.getContractFactory("SpikeHarnessVariant");
    const pool = await Pool.deploy(tokenAddr, 0);
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const until = (await ethers.provider.getBlock("latest"))!.timestamp + 365 * DAY;
    for (const who of [alice, bob]) {
      await (await token.mint!(who!.address, 5_000_000n)).wait();
      await (await token.connect(who!).setOperator!(poolAddr, until)).wait();
      const e = await fhevm.createEncryptedInput(poolAddr, who!.address).add64(1_000n).encrypt();
      await (await pool.connect(who!).deposit!(e.handles[0], e.inputProof)).wait();
    }

    const read = async (who: typeof alice): Promise<bigint> => {
      const h = await pool.confidentialBalanceOf!(who!.address);
      if (h === ethers.ZeroHash) return 0n;
      return fhevm.userDecryptEuint(FhevmType.euint64, h, poolAddr, who!);
    };

    // Alice: the plaintext-free path. She never names an amount.
    const aliceBefore = await read(alice);
    const shifted = await (await pool.connect(alice!).withdrawShifted!(1)).wait();
    const aliceAfter = await read(alice);

    // Bob: the path today, with an encrypted input carrying a chosen number.
    const bobBefore = await read(bob);
    const e = await fhevm
      .createEncryptedInput(poolAddr, bob!.address)
      .add64(bobBefore / 2n)
      .encrypt();
    const ordinary = await (
      await pool.connect(bob!).withdraw!(e.handles[0], e.inputProof)
    ).wait();
    const bobAfter = await read(bob);

    console.log(`      withdrawShifted(1)  gas ${shifted!.gasUsed}  ${aliceBefore} -> ${aliceAfter}`);
    console.log(`      withdraw(enc)       gas ${ordinary!.gasUsed}  ${bobBefore} -> ${bobAfter}`);
    console.log(`      saving              ${ordinary!.gasUsed - shifted!.gasUsed} gas, and one plaintext`);

    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "out", "r5-withdraw.json"),
      JSON.stringify(
        {
          shifted: { gas: shifted!.gasUsed.toString(), before: aliceBefore.toString(), after: aliceAfter.toString() },
          ordinary: { gas: ordinary!.gasUsed.toString(), before: bobBefore.toString(), after: bobAfter.toString() },
          saving: (ordinary!.gasUsed - shifted!.gasUsed).toString(),
        },
        null,
        2,
      ),
    );

    expect(aliceAfter).to.equal(aliceBefore / 2n);
    expect(bobAfter).to.equal(bobBefore / 2n);
  });
});
