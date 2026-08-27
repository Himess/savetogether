/**
 * SDK integration tests against live Sepolia.
 *
 * These import `@ghostkey/sdk` through the workspace link rather than reaching
 * into `src/`, so what is exercised is the surface a consumer actually gets. Mock
 * mode is for logic; anything that will be claimed out loud has to be verified
 * here, on chain.
 *
 *   pnpm build:sdk && pnpm test:sdk:sepolia
 *
 * Reuses the module and token the gate deployed, from .env.
 */
import {
  GhostKeyClient,
  OperatorNotGrantedError,
  RecipientNotAllowedError,
  ZeroAmountError,
  exact,
  memoryKeystore,
  ref,
  revealAmount,
  type Session,
} from "@ghostkey/sdk";
import { expect } from "chai";
import { Wallet, parseEther } from "ethers";
import { ethers } from "hardhat";

const DAY = 24 * 60 * 60;
const FUND = parseEther("0.04");

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`${name} is not set — run the gate first`);
  return v;
}

describe("SDK against live Sepolia", function () {
  // Each send is a real transaction plus ~12s of client-side proof generation.
  this.timeout(20 * 60 * 1000);

  const moduleAddress = required("GATE_MODULE");
  const tokenAddress = required("GATE_TOKEN");
  const rpcUrl = required("SEPOLIA_RPC_URL");

  let client: GhostKeyClient;
  let owner: Wallet;
  let recipient: string;

  before(async () => {
    const net = await ethers.provider.getNetwork();
    expect(net.chainId).to.equal(11155111n, "these tests only mean anything on Sepolia");

    const [deployer] = await ethers.getSigners();
    if (deployer === undefined) throw new Error("no signer");

    // A fresh owner per run, so no state from an earlier run can make a test pass.
    owner = new Wallet(Wallet.createRandom().privateKey, ethers.provider);
    recipient = Wallet.createRandom().address;
    await (await deployer.sendTransaction({ to: owner.address, value: FUND })).wait();

    const token = await ethers.getContractAt("MockERC7984", tokenAddress);
    await (await token.connect(deployer).mintPlain(owner.address, 100_000n)).wait();
    // Warm the recipient's balance handle so the first send is not its first write.
    await (await token.connect(deployer).mintPlain(recipient, 1n)).wait();

    client = new GhostKeyClient({
      provider: ethers.provider,
      rpcUrl,
      moduleAddress,
      keystore: memoryKeystore(),
      chainId: 11155111,
    });
  });

  describe("spend-only tier", () => {
    let session: Session;

    it("opens a session with one owner authorisation", async () => {
      const result = await client.openSession({
        owner,
        budgets: [{ token: tokenAddress, amount: 5_000n }],
        recipients: [recipient],
        expiry: new Date(Date.now() + 7 * DAY * 1000),
        readScope: "spend-only",
        label: "sdk-integration-spend-only",
      });
      session = result.session;

      expect(result.ownerAuthorisations).to.equal(1);
      expect(result.hashes.length).to.be.greaterThan(0);
      expect(session.tier).to.equal("spend-only");

      const params = await session.params();
      expect(params.owner.toLowerCase()).to.equal(owner.address.toLowerCase());
      expect(params.txCount).to.equal(0);
      expect(await session.recipients()).to.deep.equal([recipient]);
    });

    it("reports readiness as ok, including the operator grant it just made", async () => {
      const r = await session.readiness(tokenAddress);
      expect(r.reasons, r.reasons.join("; ")).to.deep.equal([]);
      expect(r.ok).to.equal(true);
      expect(r.operatorGranted).to.equal(true);
      expect(r.aclPaused).to.equal(false);
    });

    it("sends within budget and reports the amount moved", async () => {
      const result = await session.send({
        token: tokenAddress,
        to: recipient,
        amount: exact(500n),
      });
      expect(result.outcome).to.equal("sent");
      if (result.outcome !== "sent") throw new Error("unreachable");
      expect(result.amount).to.equal(500n);

      const left = await revealAmount(await session.remaining(tokenAddress), {
        reason: "integration test assertion",
      });
      expect(left).to.equal(4_500n);
    });

    it("reports an over-budget request as over-budget, without reverting", async () => {
      const result = await session.send({
        token: tokenAddress,
        to: recipient,
        amount: exact(1_000_000n),
      });
      expect(result.outcome).to.equal("over-budget");

      // And the budget is untouched, which is the property that matters.
      const left = await revealAmount(await session.remaining(tokenAddress), {
        reason: "integration test assertion",
      });
      expect(left).to.equal(4_500n);
    });

    it("refuses a zero amount before it reaches the chain", async () => {
      let threw: unknown;
      try {
        await session.send({ token: tokenAddress, to: recipient, amount: exact(0n) });
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.instanceOf(ZeroAmountError);
    });

    it("refuses a recipient outside the allowlist", async () => {
      const stranger = Wallet.createRandom().address;
      let threw: unknown;
      try {
        await session.send({ token: tokenAddress, to: stranger, amount: exact(1n) });
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.instanceOf(RecipientNotAllowedError);
    });

    it("has no balance() — the type system enforces the tier", () => {
      // `session.balance` does not exist on SpendOnlySession in TypeScript. This
      // asserts the runtime guard for JavaScript callers.
      const asAny = session as unknown as { balance?: (t: string) => unknown };
      expect(() => asAny.balance?.(tokenAddress)).to.throw(/no ACL delegation/);
    });

    it("lets the owner widen the allowlist mid-session", async () => {
      const latecomer = Wallet.createRandom().address;
      await session.addRecipient(latecomer, owner);
      expect(await session.recipients()).to.include(latecomer);

      const result = await session.send({
        token: tokenAddress,
        to: latecomer,
        amount: exact(100n),
      });
      expect(result.outcome).to.equal("sent");
    });

    it("lets the session key narrow its own scope", async () => {
      await session.removeRecipient(recipient);
      expect(await session.recipients()).to.not.include(recipient);
    });

    it("warms a proof ahead of submission", async () => {
      const remaining = await session.recipients();
      const to = remaining[0];
      if (to === undefined) throw new Error("no recipient left to send to");

      const prepared = session.prepare({ token: tokenAddress, to, amount: exact(50n) });
      const t0 = Date.now();
      await prepared.ready; // the expensive part, done before we decide to submit
      const warmMs = Date.now() - t0;

      const t1 = Date.now();
      const result = await prepared.send();
      const submitMs = Date.now() - t1;

      expect(result.outcome).to.equal("sent");
      console.log(
        `      proof ${(warmMs / 1000).toFixed(1)}s, submit+settle ${(submitMs / 1000).toFixed(1)}s`,
      );
      // The whole point: the proof is the slow half and it happens first.
      expect(warmMs).to.be.greaterThan(1000);
    });

    it("closes, and refuses to send afterwards", async () => {
      await session.close();
      const params = await session.params();
      expect(params.expiry).to.equal(0);

      const r = await session.readiness(tokenAddress);
      expect(r.sessionLive).to.equal(false);
    });
  });

  describe("balance-visible tier", () => {
    let session: Session;

    it("opens with delegation and can read the holder's balance", async () => {
      const result = await client.openSession({
        owner,
        budgets: [{ token: tokenAddress, amount: 5_000n }],
        recipients: [recipient],
        expiry: new Date(Date.now() + 7 * DAY * 1000),
        readScope: "balance-visible",
        label: "sdk-integration-balance-visible",
      });
      session = result.session;
      expect(session.tier).to.equal("balance-visible");
      expect(result.ownerAuthorisations).to.equal(1);

      if (session.tier !== "balance-visible") throw new Error("unreachable");
      const balance = await session.balance(tokenAddress);
      const plain = await revealAmount(balance, { reason: "integration test assertion" });
      expect(plain).to.be.greaterThan(0n);
    });

    it("resolves a reference amount without the caller ever seeing a number", async () => {
      if (session.tier !== "balance-visible") throw new Error("unreachable");
      const budget = await session.remaining(tokenAddress);

      // "half the remaining budget" — the SDK decrypts internally to encrypt,
      // and returns a typed result, not the plaintext.
      const result = await session.send({
        token: tokenAddress,
        to: recipient,
        amount: ref(budget).half(),
      });
      expect(result.outcome).to.equal("sent");
      if (result.outcome !== "sent") throw new Error("unreachable");
      expect(result.amount).to.equal(2_500n);

      const left = await revealAmount(await session.remaining(tokenAddress), {
        reason: "integration test assertion",
      });
      expect(left).to.equal(2_500n);
    });

    it("keeps an AmountRef opaque under interpolation and JSON", async () => {
      const budget = await session.remaining(tokenAddress);
      expect(`${budget}`).to.match(/^AmountRef\(budget:0x[0-9a-f]{8}…\)$/);
      expect(JSON.stringify({ budget })).to.not.include("2500");
    });

    it("caps a reference amount", async () => {
      if (session.tier !== "balance-visible") throw new Error("unreachable");
      const budget = await session.remaining(tokenAddress);
      const result = await session.send({
        token: tokenAddress,
        to: recipient,
        amount: ref(budget).cap(10n),
      });
      expect(result.outcome).to.equal("sent");
      if (result.outcome !== "sent") throw new Error("unreachable");
      expect(result.amount).to.equal(10n);
    });

    it("names a lapsed operator grant instead of reverting opaquely", async () => {
      const token = await ethers.getContractAt("MockERC7984", tokenAddress);
      await (await token.connect(owner).setOperator(moduleAddress, 0)).wait();

      let threw: unknown;
      try {
        await session.send({ token: tokenAddress, to: recipient, amount: exact(1n) });
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.instanceOf(OperatorNotGrantedError);

      // Restore, so the session is usable if this file is re-run.
      await (
        await token
          .connect(owner)
          .setOperator(moduleAddress, Math.floor(Date.now() / 1000) + 7 * DAY)
      ).wait();
    });

    it("closes", async () => {
      await session.close();
      expect((await session.params()).expiry).to.equal(0);
    });
  });
});
