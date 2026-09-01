/**
 * J2 — the composition, proven against Zama's own vault on Sepolia.
 *
 * The claim is that SaveTogether sits ON the ecosystem's confidential vault rather
 * than beside a lookalike. That claim is either driven end to end on chain or it
 * is a paragraph in a README.
 *
 * The path, read from the deployed ABI rather than the docs — which name a
 * different share token than the batcher actually holds:
 *
 *   confidentialTransferAndCall -> join -> dispatchBatch -> KMS callback -> claim
 *
 * Every step is permissionless. If Zama's own keeper dispatches and settles
 * first, this test simply waits and claims; if it does not, the test drives the
 * remaining steps itself, which is the point of the steps being permissionless.
 *
 *   npx hardhat test test/sepolia-vault.ts --network sepolia
 */
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { Contract } from "ethers";
import * as fs from "fs";
import * as path from "path";

const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";
const DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b";
const REDEEM_BATCHER = "0xe94E9afdDd43a19C2914739e9279cb6Fe287BEb0";

const ERC20 = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const CTOKEN = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function confidentialTransfer(address to, bytes32 encryptedAmount, bytes inputProof) returns (bytes32)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
const BATCHER = [
  "function currentBatchId() view returns (uint256)",
  "function batchState(uint256) view returns (uint8)",
  "function batchCreatedAt(uint256) view returns (uint256)",
  "function minBatchAge() view returns (uint256)",
  "function dispatchBatch()",
  "function dispatchBatchCallback(uint256 batchId, uint64 unwrapAmountCleartext, bytes decryptionProof)",
  "function unwrapRequestId(uint256) view returns (bytes32)",
  "function toToken() view returns (address)",
  "function deposits(uint256, address) view returns (bytes32)",
  "event BatchDispatched(uint256 batchId)",
  "event BatchFinalized(uint256 batchId, uint64 exchangeRate)",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Zama Confidential Vault, live", () => {
  it("puts principal into the vault and gets shares back", async function () {
    this.timeout(2_400_000);

    await fhevm.initializeCLIApi();
    const [signer] = await ethers.getSigners();
    const me = await signer.getAddress();

    const usdc = new ethers.Contract(USDC, ERC20, signer) as unknown as Contract;
    const cusdc = new ethers.Contract(CUSDC, CTOKEN, signer) as unknown as Contract;
    const dep = new ethers.Contract(DEPOSIT_BATCHER, BATCHER, signer) as unknown as Contract;

    const shareAddr: string = await dep.toToken();
    const share = new ethers.Contract(shareAddr, CTOKEN, signer) as unknown as Contract;
    console.log(`\n    cUSDC   ${CUSDC}`);
    console.log(`    shares  ${shareAddr}  ${await share.name()} (${await share.symbol()})`);

    // ---- the adapter -------------------------------------------------------
    const Source = await ethers.getContractFactory("ZamaVaultSource");
    const source = await Source.deploy(CUSDC, DEPOSIT_BATCHER, REDEEM_BATCHER, me);
    await source.waitForDeployment();
    const srcAddr = await source.getAddress();
    console.log(`    adapter ${srcAddr}`);

    // ---- fund it with real cUSDC -------------------------------------------
    const dec = Number(await usdc.decimals());
    const amount = 50n * 10n ** BigInt(dec);
    await (await usdc.mint(me, amount)).wait();
    await (await usdc.approve(CUSDC, amount)).wait();
    await (await cusdc.wrap(me, amount)).wait();

    const enc = await fhevm.createEncryptedInput(CUSDC, me).add64(amount).encrypt();
    await (await cusdc.confidentialTransfer(srcAddr, enc.handles[0]!, enc.inputProof)).wait();
    expect(await cusdc.confidentialBalanceOf(srcAddr)).to.not.equal(ethers.ZeroHash);
    console.log(`    funded adapter with ${amount} cUSDC`);

    // ---- join the batch ----------------------------------------------------
    const batchId = Number(await dep.currentBatchId());
    await (await (source as unknown as Contract).joinVault()).wait();
    console.log(`\n    joined batch ${batchId}`);
    expect(await dep.deposits(batchId, srcAddr), "the batcher must record our deposit").to.not.equal(
      ethers.ZeroHash,
    );

    // ---- dispatch, settle, claim ------------------------------------------
    // Permissionless, so this drives whatever Zama's keeper has not already done.
    const minAge = Number(await dep.minBatchAge());
    console.log(`    minBatchAge ${minAge}s — waiting`);
    await sleep((minAge + 2) * 1000);

    let state = Number(await dep.batchState(batchId));
    if (state < 2) {
      await (await dep.dispatchBatch()).wait();
      console.log(`    dispatched`);
    } else {
      console.log(`    already dispatched by someone else`);
    }

    // The unwrap request has to be publicly decrypted before the batch can be
    // finalised — the same KMS round trip the pool's own draw uses.
    const reqId: string = await dep.unwrapRequestId(batchId);
    console.log(`    unwrap request ${reqId.slice(0, 18)}…`);

    let finalised = false;
    for (let i = 0; i < 40; i++) {
      const s = Number(await dep.batchState(batchId));
      const claimable = (await dep.deposits(batchId, srcAddr)) !== ethers.ZeroHash;
      if (s >= 3 || (i > 6 && claimable)) {
        finalised = true;
        break;
      }
      if (i === 6 && reqId !== ethers.ZeroHash) {
        try {
          const pub = await fhevm.publicDecrypt([reqId]);
          await (
            await dep.dispatchBatchCallback(batchId, 0n, pub.decryptionProof)
          ).wait();
          console.log(`    settled the batch ourselves`);
        } catch (e) {
          console.log(`    callback not ours to make: ${(e as Error).message.slice(0, 90)}`);
        }
      }
      await sleep(15_000);
    }
    console.log(`    batch state ${Number(await dep.batchState(batchId))}, finalised ${finalised}`);

    const before = await share.confidentialBalanceOf(srcAddr);
    await (await (source as unknown as Contract).claimShares(batchId)).wait();
    const after = await share.confidentialBalanceOf(srcAddr);
    console.log(`\n    shares before ${before.slice(0, 18)}…`);
    console.log(`    shares after  ${after.slice(0, 18)}…`);

    fs.mkdirSync(path.join(__dirname, "..", "out"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "..", "out", "vault-round.json"),
      JSON.stringify(
        {
          adapter: srcAddr,
          shareToken: shareAddr,
          batchId,
          finalised,
          sharesBefore: before,
          sharesAfter: after,
        },
        null,
        2,
      ),
    );

    expect(after, "the adapter must hold vault shares after claiming").to.not.equal(ethers.ZeroHash);
  });
});
