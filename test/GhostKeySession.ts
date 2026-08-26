import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";

import type { GhostKeySession, MockERC7984 } from "../types";

const DAY = 24 * 60 * 60;

/** One send's worth of encrypted input, bound to the module and the session key. */
async function encFor(module: string, from: string, value: bigint) {
  return fhevm.createEncryptedInput(module, from).add64(value).encrypt();
}

/** getSigners() is possibly-undefined under noUncheckedIndexedAccess; assert once, here. */
function requireSigner(list: HardhatEthersSigner[], i: number): HardhatEthersSigner {
  const s = list[i];
  if (s === undefined) throw new Error(`no signer at index ${i}`);
  return s;
}

async function future(seconds = 7 * DAY): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return (block?.timestamp ?? Math.floor(Date.now() / 1000)) + seconds;
}

describe("GhostKeySession", () => {
  let module: GhostKeySession;
  let moduleAddr: string;
  let token: MockERC7984;
  let tokenAddr: string;
  let token2: MockERC7984;
  let token2Addr: string;

  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let sessionKey: HardhatEthersSigner;
  let recipient: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    deployer = requireSigner(signers, 0);
    owner = requireSigner(signers, 1);
    sessionKey = requireSigner(signers, 2);
    recipient = requireSigner(signers, 3);
    outsider = requireSigner(signers, 4);

    const Module = await ethers.getContractFactory("GhostKeySession");
    module = (await Module.connect(deployer).deploy()) as GhostKeySession;
    moduleAddr = await module.getAddress();

    const Token = await ethers.getContractFactory("MockERC7984");
    token = (await Token.connect(deployer).deploy("cUSDC", "cUSDC", "")) as MockERC7984;
    tokenAddr = await token.getAddress();
    token2 = (await Token.connect(deployer).deploy("cWETH", "cWETH", "")) as MockERC7984;
    token2Addr = await token2.getAddress();
  });

  /** Funds a holder, makes the module their operator, and opens a single-token session. */
  async function openBasicSession(
    holder: HardhatEthersSigner,
    key: HardhatEthersSigner,
    opts: { balance: bigint; budget: bigint; maxTxCount?: number; recipients?: string[] },
  ): Promise<void> {
    await (await token.connect(deployer).mintPlain(holder.address, opts.balance)).wait();
    await (await token.connect(holder).setOperator(moduleAddr, await future())).wait();

    const enc = await fhevm
      .createEncryptedInput(moduleAddr, holder.address)
      .add64(opts.budget)
      .encrypt();

    await (
      await module.connect(holder).openSession(
        {
          sessionKey: key.address,
          expiry: await future(),
          maxTxCount: opts.maxTxCount ?? 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: opts.recipients ?? [recipient.address],
        },
        enc.inputProof,
      )
    ).wait();
  }

  async function readRemaining(key: string, tkn: string, as: HardhatEthersSigner): Promise<bigint> {
    const handle = await module.remainingOf(key, tkn);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, moduleAddr, as);
  }

  async function readBalance(who: string, as: HardhatEthersSigner, tkn = token): Promise<bigint> {
    const handle = await tkn.confidentialBalanceOf(who);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, await tkn.getAddress(), as);
  }

  /** Pulls the `within` / `sent` handles out of the Sent event of a mined send. */
  async function sentEvent(txHash: string) {
    const receipt = await ethers.provider.getTransactionReceipt(txHash);
    const log = receipt!.logs.find((l) => l.address.toLowerCase() === moduleAddr.toLowerCase());
    const parsed = module.interface.parseLog({ topics: [...log!.topics], data: log!.data });
    return { within: parsed!.args.within as string, sent: parsed!.args.sent as string };
  }

  // -------------------------------------------------------------------------
  // 1. THE INDISTINGUISHABILITY TEST — the project's core claim.
  //
  // A successful transfer, a budget-rejected transfer and a balance-rejected
  // transfer must be indistinguishable to an observer: no revert, identical
  // event topics, and — because FHE.select and FHE.add mint a fresh handle on
  // every path — identical gas.
  //
  // The three paths use separate owners, separate session keys and a recipient
  // warmed beforehand, so every storage slot each path touches is cold in the
  // same way. Any gas difference would be an information leak.
  // -------------------------------------------------------------------------
  it("1. is indistinguishable: success, over-budget and insufficient-balance cost the same gas", async () => {
    const signers = await ethers.getSigners();
    const holders = [5, 6, 7].map((i) => requireSigner(signers, i));
    const keys = [8, 9, 10].map((i) => requireSigner(signers, i));

    // Warm the recipient so `_balances[to]` is initialized for all three paths.
    await (await token.connect(deployer).mintPlain(recipient.address, 1n)).wait();

    // success: budget 1000 >= 500, balance 1000 >= 500
    // over-budget: budget 100 < 500
    // short-balance: budget 1000 >= 500 but balance 100 < 500
    const setups = [
      { balance: 1000n, budget: 1000n, label: "success" },
      { balance: 1000n, budget: 100n, label: "over-budget" },
      { balance: 100n, budget: 1000n, label: "short-balance" },
    ];

    for (let i = 0; i < 3; i++) {
      await openBasicSession(holders[i]!, keys[i]!, {
        balance: setups[i]!.balance,
        budget: setups[i]!.budget,
      });
    }

    const results: { label: string; gas: bigint; topics: string[]; dataLen: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const enc = await encFor(moduleAddr, keys[i]!.address, 500n);
      const tx = await module
        .connect(keys[i]!)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof);
      const receipt = await tx.wait();
      const log = receipt!.logs.find((l) => l.address.toLowerCase() === moduleAddr.toLowerCase())!;
      results.push({
        label: setups[i]!.label,
        gas: receipt!.gasUsed,
        topics: [...log.topics],
        dataLen: log.data.length,
      });
    }

    // Confirm the three paths really are the three different outcomes.
    expect(await readRemaining(keys[0]!.address, tokenAddr, holders[0]!)).to.equal(500n); // spent
    expect(await readRemaining(keys[1]!.address, tokenAddr, holders[1]!)).to.equal(100n); // untouched
    expect(await readRemaining(keys[2]!.address, tokenAddr, holders[2]!)).to.equal(1000n); // restored

    console.log("\n    indistinguishability:");
    for (const r of results) console.log(`      ${r.label.padEnd(16)} gas ${r.gas}`);

    // Same event shape. topics[1] is the indexed session key, which necessarily differs
    // between the three paths; everything an observer could use to classify the outcome —
    // the event signature, the token, the recipient, and the payload size — is identical.
    for (const r of [results[1]!, results[2]!]) {
      expect(r.topics.length).to.equal(results[0]!.topics.length);
      expect(r.topics[0]).to.equal(results[0]!.topics[0]); // event signature
      expect(r.topics[2]).to.equal(results[0]!.topics[2]); // token
      expect(r.topics[3]).to.equal(results[0]!.topics[3]); // recipient
      expect(r.dataLen).to.equal(results[0]!.dataLen);
    }

    // Same gas, exactly.
    expect(results[1]!.gas).to.equal(results[0]!.gas);
    expect(results[2]!.gas).to.equal(results[0]!.gas);
  });

  // -------------------------------------------------------------------------
  // 2. Boundary
  // -------------------------------------------------------------------------
  it("2. spends exactly at the budget and clamps one wei over it", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });

    let enc = await encFor(moduleAddr, sessionKey.address, 1000n);
    await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
    ).wait();
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(0n);
    expect(await readBalance(recipient.address, recipient)).to.equal(1000n);

    // One over an exhausted budget: clamped, no revert, nothing moves.
    enc = await encFor(moduleAddr, sessionKey.address, 1n);
    await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
    ).wait();
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(0n);
    expect(await readBalance(recipient.address, recipient)).to.equal(1000n);
  });

  // -------------------------------------------------------------------------
  // 3. The refund path. Get this wrong and the budget leaks silently.
  // -------------------------------------------------------------------------
  it("3. does NOT decrement the budget when the holder's balance is insufficient", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10n, budget: 1000n });

    const enc = await encFor(moduleAddr, sessionKey.address, 500n);
    const tx = await module
      .connect(sessionKey)
      .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof);
    await tx.wait();

    // Budget restored in full, nothing moved.
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(1000n);
    expect(await readBalance(owner.address, owner)).to.equal(10n);

    // The client can tell the two failures apart: within is TRUE here.
    const ev = await sentEvent(tx.hash);
    expect(await fhevm.userDecryptEbool(ev.within, moduleAddr, owner)).to.equal(true);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, ev.sent, moduleAddr, owner)).to.equal(
      0n,
    );
  });

  it("3b. reports an over-budget request as within=false, distinguishing it from a short balance", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 100n });

    const enc = await encFor(moduleAddr, sessionKey.address, 500n);
    const tx = await module
      .connect(sessionKey)
      .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof);
    await tx.wait();

    const ev = await sentEvent(tx.hash);
    expect(await fhevm.userDecryptEbool(ev.within, moduleAddr, owner)).to.equal(false);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, ev.sent, moduleAddr, owner)).to.equal(
      0n,
    );
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(100n);
  });

  // -------------------------------------------------------------------------
  // 4. Draining
  // -------------------------------------------------------------------------
  it("4. drains the budget exactly to zero over repeated sends, then stops moving value", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 300n });

    for (let i = 0; i < 3; i++) {
      const enc = await encFor(moduleAddr, sessionKey.address, 100n);
      await (
        await module
          .connect(sessionKey)
          .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
      ).wait();
    }
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(0n);
    expect(await readBalance(recipient.address, recipient)).to.equal(300n);

    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
    ).wait();
    expect(await readBalance(recipient.address, recipient)).to.equal(300n);
  });

  // -------------------------------------------------------------------------
  // 5. Multi-token isolation, and A4: both budgets funded in ONE transaction
  //    under ONE proof.
  // -------------------------------------------------------------------------
  it("5. funds two tokens in one transaction and keeps their budgets isolated", async () => {
    await (await token.connect(deployer).mintPlain(owner.address, 10_000n)).wait();
    await (await token2.connect(deployer).mintPlain(owner.address, 10_000n)).wait();
    await (await token.connect(owner).setOperator(moduleAddr, await future())).wait();
    await (await token2.connect(owner).setOperator(moduleAddr, await future())).wait();

    // One createEncryptedInput, two values, one proof, one signature.
    const enc = await fhevm
      .createEncryptedInput(moduleAddr, owner.address)
      .add64(1000n)
      .add64(2000n)
      .encrypt();
    expect(enc.handles.length).to.equal(2);

    await (
      await module.connect(owner).openSession(
        {
          sessionKey: sessionKey.address,
          expiry: await future(),
          maxTxCount: 0,
          tokens: [tokenAddr, token2Addr],
          budgets: [enc.handles[0]!, enc.handles[1]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
      )
    ).wait();

    expect(await module.tokensOf(sessionKey.address)).to.deep.equal([tokenAddr, token2Addr]);

    const send1 = await encFor(moduleAddr, sessionKey.address, 400n);
    await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, send1.handles[0]!, send1.inputProof)
    ).wait();

    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(600n);
    expect(await readRemaining(sessionKey.address, token2Addr, owner)).to.equal(2000n);
  });

  // -------------------------------------------------------------------------
  // 6. Plaintext guards
  // -------------------------------------------------------------------------
  it("6a. rejects a send after expiry", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await ethers.provider.send("evm_increaseTime", [8 * DAY]);
    await ethers.provider.send("evm_mine", []);

    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await expect(
      module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "SessionExpired");
  });

  it("6b. rejects a recipient that is not on the allowlist", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await expect(
      module.connect(sessionKey).send(tokenAddr, outsider.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "RecipientNotAllowed");
  });

  it("6c. enforces maxTxCount", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n, maxTxCount: 1 });

    let enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
    ).wait();

    enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await expect(
      module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "TxCountExhausted");
  });

  it("6d. rejects a send from a closed session", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await (await module.connect(owner).closeSession(sessionKey.address)).wait();

    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await expect(
      module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "SessionIsClosed");
  });

  // -------------------------------------------------------------------------
  // 7. Authorisation
  // -------------------------------------------------------------------------
  it("7. rejects a caller that is not a session key", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    const enc = await encFor(moduleAddr, outsider.address, 100n);
    await expect(
      module.connect(outsider).send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "NoSuchSession");
  });

  // -------------------------------------------------------------------------
  // 8. Closing
  // -------------------------------------------------------------------------
  it("8a. lets the owner close, and the session key close itself", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await expect(module.connect(sessionKey).closeSession(sessionKey.address)).to.emit(
      module,
      "SessionClosed",
    );

    const key2 = requireSigner(await ethers.getSigners(), 11);
    await openBasicSession(outsider, key2, { balance: 10_000n, budget: 1000n });
    await expect(module.connect(outsider).closeSession(key2.address)).to.emit(
      module,
      "SessionClosed",
    );
  });

  it("8b. rejects an unrelated closer", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await expect(
      module.connect(outsider).closeSession(sessionKey.address),
    ).to.be.revertedWithCustomError(module, "NotOwnerOrSessionKey");
  });

  it("8c. consumes a session key permanently, so it can never be reopened", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await (await module.connect(owner).closeSession(sessionKey.address)).wait();

    const enc = await fhevm.createEncryptedInput(moduleAddr, owner.address).add64(1000n).encrypt();
    await expect(
      module.connect(owner).openSession(
        {
          sessionKey: sessionKey.address,
          expiry: await future(),
          maxTxCount: 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
      ),
    ).to.be.revertedWithCustomError(module, "SessionKeyAlreadyUsed");
  });

  // -------------------------------------------------------------------------
  // 9. Budget top-up
  // -------------------------------------------------------------------------
  it("9. lets only the owner top up a budget", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });

    let enc = await fhevm.createEncryptedInput(moduleAddr, outsider.address).add64(500n).encrypt();
    await expect(
      module
        .connect(outsider)
        .increaseBudget(sessionKey.address, tokenAddr, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "NotSessionOwner");

    enc = await fhevm.createEncryptedInput(moduleAddr, owner.address).add64(500n).encrypt();
    await (
      await module
        .connect(owner)
        .increaseBudget(sessionKey.address, tokenAddr, enc.handles[0]!, enc.inputProof)
    ).wait();
    expect(await readRemaining(sessionKey.address, tokenAddr, owner)).to.equal(1500n);
  });

  // -------------------------------------------------------------------------
  // A1. The token guard. An uninitialized budget stops spending; this stops
  //     the CALL, and with it the transient ACL grant to an arbitrary address.
  // -------------------------------------------------------------------------
  it("A1. refuses to call a token that was not funded at openSession", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    await expect(
      module
        .connect(sessionKey)
        .send(token2Addr, recipient.address, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "TokenNotInSession");
  });

  // -------------------------------------------------------------------------
  // 10. Gas / HCU envelope
  // -------------------------------------------------------------------------
  it("10. stays within the HCU envelope estimated in the design review", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    const enc = await encFor(moduleAddr, sessionKey.address, 100n);
    const receipt = await (
      await module
        .connect(sessionKey)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
    ).wait();

    // Analytic estimate from the design review: 1,334,064 HCU, well under the
    // 20,000,000 per-tx ceiling. Mock mode does not meter HCU, so the assertion
    // here is on the operation shape via EVM gas; the HCU figure is verified on
    // Sepolia in the integration run.
    console.log(`\n    send() gas: ${receipt!.gasUsed}`);
    expect(receipt!.gasUsed).to.be.lessThan(3_000_000n);
  });

  // -------------------------------------------------------------------------
  // 11. Fuzz invariant
  // -------------------------------------------------------------------------
  it("11. never lets total sent exceed the initial budget, over a random sequence", async () => {
    const INITIAL = 1000n;
    await openBasicSession(owner, sessionKey, { balance: 100_000n, budget: INITIAL });

    // Deterministic pseudo-random sequence: reproducible, and it straddles the
    // budget boundary so both accepted and clamped requests occur.
    let seed = 42n;
    const next = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return (seed >> 33n) % 400n;
    };

    for (let i = 0; i < 8; i++) {
      const amount = next();
      const enc = await encFor(moduleAddr, sessionKey.address, amount);
      await (
        await module
          .connect(sessionKey)
          .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof)
      ).wait();
    }

    const received = await readBalance(recipient.address, recipient);
    const remaining = await readRemaining(sessionKey.address, tokenAddr, owner);
    expect(received).to.be.lessThanOrEqual(INITIAL);
    expect(received + remaining).to.equal(INITIAL);
  });
});
