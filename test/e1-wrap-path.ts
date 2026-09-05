/**
 * E1 — does `ERC7984ZeroBalance` live on the wrap path rather than the transfer path?
 *
 * D1 exercised three transfer cases against deployed cUSDC and all three clamped.
 * That leaves a third explanation for the earlier probe result open: the error
 * may belong to `ERC7984ERC20Wrapper` rather than the `ERC7984` base, in which
 * case both observations are correct and describe different functions.
 *
 * There is no leakage question here — a wrap is a public action moving a public
 * ERC-20 amount, so a revert discloses nothing. It is a UX question, and the
 * bounty's deposit flow starts from an ERC-20, so a revert in front of a judge is
 * a failure that costs nothing to rule out now.
 *
 *   npx hardhat test test/e1-wrap-path.ts --network sepolia
 */
import { ethers, fhevm } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639";
const USDC_MOCK = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF";

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function underlying() view returns (address)",
];
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function attempt(fn: () => Promise<unknown>): Promise<{ reverted: boolean; detail: string }> {
  try {
    await fn();
    return { reverted: false, detail: "succeeded" };
  } catch (e) {
    return { reverted: true, detail: (e as Error).message.slice(0, 240) };
  }
}

describe("E1 — the wrap path on deployed cUSDC", () => {
  it("wraps from an account the wrapper has never seen", async function () {
    this.timeout(1_800_000);

    await fhevm.initializeCLIApi();
    const [probe] = await ethers.getSigners();
    const results: Record<string, unknown> = {};

    const stranger = ethers.Wallet.createRandom().connect(ethers.provider);
    console.log(`\n    stranger ${stranger.address} (never wrapped)`);
    await (
      await probe.sendTransaction({ to: stranger.address, value: ethers.parseEther("0.03") })
    ).wait();

    const underlying = new ethers.Contract(USDC_MOCK, ERC20_ABI, stranger);
    const wrapper = new ethers.Contract(CUSDC, WRAPPER_ABI, stranger);

    const dec = Number(await underlying.decimals());
    const amount = 250n * 10n ** BigInt(dec);

    // Case W0 — wrap with no underlying and no approval at all. This is the
    // closest analogue to D1's case A on the wrap side.
    const w0 = await attempt(async () => (await wrapper.wrap(stranger.address, amount)).wait());
    console.log(`\n    CASE W0  wrap with no balance, no approval`);
    console.log(`      ${w0.reverted ? "REVERTED" : "SUCCEEDED"}  ${w0.detail}`);
    results["W0"] = w0;

    // Case W1 — the ordinary deposit flow a judge will follow: mint, approve, wrap.
    await (await underlying.mint(stranger.address, amount)).wait();
    await (await underlying.approve(CUSDC, amount)).wait();
    const w1 = await attempt(async () => (await wrapper.wrap(stranger.address, amount)).wait());
    console.log(`\n    CASE W1  mint, approve, wrap  (the deposit flow)`);
    console.log(`      ${w1.reverted ? "REVERTED" : "SUCCEEDED"}  ${w1.detail}`);
    results["W1"] = w1;

    const handle = await wrapper.confidentialBalanceOf(stranger.address);
    console.log(`      confidential balance handle now ${handle}`);
    results["handleAfterWrap"] = handle;

    // Case W2 — wrap zero. A deposit UI that lets someone submit an empty field
    // reaches this, and it is the wrap-side analogue of D1's case B.
    const w2 = await attempt(async () => (await wrapper.wrap(stranger.address, 0n)).wait());
    console.log(`\n    CASE W2  wrap zero`);
    console.log(`      ${w2.reverted ? "REVERTED" : "SUCCEEDED"}  ${w2.detail}`);
    results["W2"] = w2;

    const out = path.join(__dirname, "..", "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "e1-wrap.json"), JSON.stringify(results, null, 2));
    console.log(`\n    written to out/e1-wrap.json`);
  });
});
