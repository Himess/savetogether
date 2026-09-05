/**
 * D1 — does the deployed cUSDC wrapper clamp, or revert?
 *
 * `contracts/ConfidentialPrizePool.sol` withdraws by handing the token an amount
 * that may be an encrypted zero, and relies on the token moving zero rather than
 * reverting. OpenZeppelin's v0.5.1 `ERC7984` base does clamp. An earlier probe
 * of ours recorded that the wrappers deployed on Sepolia instead revert
 * `ERC7984ZeroBalance` on a never-funded `from` — and that error string does not
 * appear anywhere in the v0.5.1 source installed here, which is itself evidence
 * that the deployed code is not the code in node_modules.
 *
 * A revert is exactly the observable this design spends its whole budget
 * avoiding, so this has to be answered before the draw is written, not after.
 *
 * Two cases, because they fail for different reasons and only one of them is on
 * the pool's hot path:
 *
 *   A. a `from` the token has never seen transfers a positive amount
 *   B. a funded `from` transfers an ENCRYPTED ZERO      <- the pool's clamp path
 *
 *   npx hardhat test test/d1-wrapper-revert.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import { Contract } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import * as fs from "fs";
import * as path from "path";

const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";

const ERC7984_ABI = [
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)",
  "function decimals() view returns (uint8)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function underlying() view returns (address)",
];
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

interface Outcome {
  readonly reverted: boolean;
  readonly detail: string;
}

async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    await fn();
    return { reverted: false, detail: "succeeded" };
  } catch (e) {
    const m = (e as Error).message;
    return { reverted: true, detail: m.slice(0, 220) };
  }
}

describe("D1 — deployed cUSDC: clamp or revert", () => {
  it("answers both cases against the real wrapper", async function () {
    this.timeout(1_800_000);

    await fhevm.initializeCLIApi();
    const [probe] = await ethers.getSigners();
    const probeAddr = await probe.getAddress();
    const cusdc = new Contract(CUSDC, ERC7984_ABI, probe);

    console.log(`\n    probe    ${probeAddr}`);
    console.log(`    cUSDC    ${CUSDC}`);
    console.log(`    decimals ${await cusdc.decimals()}`);
    console.log(`    underlying ${await cusdc.underlying()}`);

    const results: Record<string, unknown> = { cusdc: CUSDC };

    // ---------------------------------------------------------------------
    // Case A — a `from` the token has never seen.
    //
    // A brand-new address, funded with just enough ETH to pay for one failed
    // transaction. Deriving it from a random wallet rather than a fixed seed so
    // a rerun cannot accidentally reuse an address that has since been funded.
    // ---------------------------------------------------------------------
    const stranger = ethers.Wallet.createRandom().connect(ethers.provider);
    console.log(`\n    stranger ${stranger.address} (never held cUSDC)`);

    await (
      await probe.sendTransaction({ to: stranger.address, value: ethers.parseEther("0.02") })
    ).wait();

    const strangerBal = await cusdc.confidentialBalanceOf(stranger.address);
    console.log(`    stranger balance handle ${strangerBal}`);
    const uninitialised = strangerBal === ethers.ZeroHash;
    console.log(`    handle is uninitialised: ${uninitialised}`);

    const encA = await fhevm.createEncryptedInput(CUSDC, stranger.address).add64(100n).encrypt();
    const caseA = await attempt(async () => {
      const tx = await (cusdc.connect(stranger) as Contract).confidentialTransfer(
        probeAddr,
        encA.handles[0],
        encA.inputProof,
      );
      return tx.wait();
    });
    console.log(`\n    CASE A  never-funded from, amount 100`);
    console.log(`      ${caseA.reverted ? "REVERTED" : "SUCCEEDED"}  ${caseA.detail}`);
    results["caseA"] = { ...caseA, stranger: stranger.address, handleUninitialised: uninitialised };

    // ---------------------------------------------------------------------
    // Case B — a funded `from` sends an encrypted zero.
    //
    // This is the pool's clamp path: an over-withdrawal selects zero and hands
    // that to the token. If this reverts, the withdrawal design is broken.
    // ---------------------------------------------------------------------
    const underlying = new Contract(USDC_MOCK, ERC20_ABI, probe);
    let funded = (await cusdc.confidentialBalanceOf(probeAddr)) !== ethers.ZeroHash;
    console.log(`\n    probe already holds cUSDC: ${funded}`);

    if (!funded) {
      const dec = Number(await underlying.decimals());
      const amount = 1_000n * 10n ** BigInt(dec);
      console.log(`    minting ${amount} underlying and wrapping`);
      await (await underlying.mint(probeAddr, amount)).wait();
      await (await underlying.approve(CUSDC, amount)).wait();
      await (await cusdc.wrap(probeAddr, amount)).wait();
      funded = (await cusdc.confidentialBalanceOf(probeAddr)) !== ethers.ZeroHash;
      console.log(`    funded now: ${funded}`);
    }

    const encZero = await fhevm.createEncryptedInput(CUSDC, probeAddr).add64(0n).encrypt();
    const caseB = await attempt(async () => {
      const tx = await cusdc.confidentialTransfer(
        stranger.address,
        encZero.handles[0],
        encZero.inputProof,
      );
      return tx.wait();
    });
    console.log(`\n    CASE B  funded from, ENCRYPTED ZERO  (the pool's clamp path)`);
    console.log(`      ${caseB.reverted ? "REVERTED" : "SUCCEEDED"}  ${caseB.detail}`);
    results["caseB"] = { ...caseB, funded };

    // ---------------------------------------------------------------------
    // Case C — a funded `from` overdraws. The pool never does this (it clamps
    // first), but it establishes whether the token's own clamp exists at all.
    // ---------------------------------------------------------------------
    if (funded) {
      const encHuge = await fhevm
        .createEncryptedInput(CUSDC, probeAddr)
        .add64(18_000_000_000_000_000_000n)
        .encrypt();
      const caseC = await attempt(async () => {
        const tx = await cusdc.confidentialTransfer(
          stranger.address,
          encHuge.handles[0],
          encHuge.inputProof,
        );
        return tx.wait();
      });
      console.log(`\n    CASE C  funded from, amount far above balance`);
      console.log(`      ${caseC.reverted ? "REVERTED" : "SUCCEEDED"}  ${caseC.detail}`);
      results["caseC"] = caseC;

      const after = await cusdc.confidentialBalanceOf(probeAddr);
      const bal = await fhevm.userDecryptEuint(FhevmType.euint64, after, CUSDC, probe);
      console.log(`      probe balance after: ${bal}`);
      results["balanceAfterOverdraw"] = bal.toString();
    }

    const out = path.join(__dirname, "..", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "d1-wrapper.json"), JSON.stringify(results, null, 2));
    console.log(`\n    written to out/d1-wrapper.json`);
  });
});
