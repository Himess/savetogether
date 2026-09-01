import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";

import type { SaveTogetherSession, MockERC7984 } from "../types";

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

/**
 * Intrinsic calldata cost under EIP-2028: 4 gas per zero byte, 16 per non-zero byte.
 * Subtracting it from gasUsed isolates what the contract actually executed.
 */
function calldataGas(data: string): { zeros: number; gas: number } {
  const bytes = ethers.getBytes(data);
  let zeros = 0;
  for (const b of bytes) if (b === 0) zeros++;
  return { zeros, gas: zeros * 4 + (bytes.length - zeros) * 16 };
}

async function future(seconds = 7 * DAY): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return (block?.timestamp ?? Math.floor(Date.now() / 1000)) + seconds;
}

describe("SaveTogetherSession", () => {
  let module: SaveTogetherSession;
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

    const Module = await ethers.getContractFactory("SaveTogetherSession");
    module = (await Module.connect(deployer).deploy()) as SaveTogetherSession;
    moduleAddr = await module.getAddress();

    const Token = await ethers.getContractFactory("MockERC7984");
    token = (await Token.connect(deployer).deploy("cUSDC", "cUSDC", "")) as MockERC7984;
    tokenAddr = await token.getAddress();
    token2 = (await Token.connect(deployer).deploy("cWETH", "cWETH", "")) as MockERC7984;
    token2Addr = await token2.getAddress();
  });

  /**
   * The session key's EIP-712 consent. chainId and verifyingContract live in the domain,
   * which is what makes a signature useless on another chain or another deployment.
   */
  async function signOpen(
    key: HardhatEthersSigner,
    ownerAddr: string,
    expiry: number,
    maxTxCount: number,
    overrides?: { chainId?: bigint; verifyingContract?: string },
  ): Promise<string> {
    const net = await ethers.provider.getNetwork();
    return key.signTypedData(
      {
        // "GhostKeySession", not the contract's new name, and the difference is
        // load-bearing. The domain name is hashed into the separator, so it is
        // part of every signature rather than a label on one; the deployed module
        // carries this string and the constructor still passes it. A project-wide
        // rename changed this literal and 23 tests began failing with
        // InvalidSessionKeySignature — which is exactly what a live session would
        // have done.
        name: "GhostKeySession",
        version: "1",
        chainId: overrides?.chainId ?? net.chainId,
        verifyingContract: overrides?.verifyingContract ?? moduleAddr,
      },
      {
        OpenSession: [
          { name: "owner", type: "address" },
          { name: "sessionKey", type: "address" },
          { name: "expiry", type: "uint48" },
          { name: "maxTxCount", type: "uint24" },
        ],
      },
      { owner: ownerAddr, sessionKey: key.address, expiry, maxTxCount },
    );
  }

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

    const expiry = await future();
    const maxTxCount = opts.maxTxCount ?? 0;
    const sig = await signOpen(key, holder.address, expiry, maxTxCount);

    await (
      await module.connect(holder).openSession(
        {
          sessionKey: key.address,
          expiry,
          maxTxCount,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: opts.recipients ?? [recipient.address],
        },
        enc.inputProof,
        sig,
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
  // event shape, and identical cost.
  //
  // The assertion is on EXECUTION gas, i.e. gasUsed minus intrinsic calldata
  // cost. That is the sharper claim and the correct one. Total gasUsed also
  // includes 4 gas per zero calldata byte and 16 per non-zero, and the caller's
  // encrypted amount and input proof are fresh ciphertext whose zero-byte count
  // varies at random. That variation is generated before the contract runs and
  // cannot depend on whether the budget will be exceeded, so it carries no
  // information about the outcome — but it does perturb total gas by multiples
  // of 12, which would make a total-gas assertion flap for the wrong reason.
  //
  // What must be exactly equal is everything the contract does. It is: FHE.select
  // and FHE.add mint a fresh handle on every path regardless of the encrypted
  // condition, so `remaining` is always written with a changed value and the
  // same-value SSTORE discount never applies anywhere.
  //
  // The three paths use separate owners, separate session keys and a recipient
  // warmed beforehand, so every storage slot each path touches is cold in the
  // same way. Any execution-gas difference would be an information leak.
  // -------------------------------------------------------------------------
  it("1. is indistinguishable: all three paths execute for exactly the same gas", async () => {
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

    const results: {
      label: string;
      gas: bigint;
      cd: number;
      zeros: number;
      exec: bigint;
      topics: string[];
      dataLen: number;
    }[] = [];
    for (let i = 0; i < 3; i++) {
      const enc = await encFor(moduleAddr, keys[i]!.address, 500n);
      const tx = await module
        .connect(keys[i]!)
        .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof);
      const receipt = await tx.wait();
      const sentTx = await ethers.provider.getTransaction(tx.hash);
      const cd = calldataGas(sentTx!.data);
      const log = receipt!.logs.find((l) => l.address.toLowerCase() === moduleAddr.toLowerCase())!;
      results.push({
        label: setups[i]!.label,
        gas: receipt!.gasUsed,
        cd: cd.gas,
        zeros: cd.zeros,
        exec: receipt!.gasUsed - BigInt(cd.gas),
        topics: [...log.topics],
        dataLen: log.data.length,
      });
    }

    // Confirm the three paths really are the three different outcomes.
    expect(await readRemaining(keys[0]!.address, tokenAddr, holders[0]!)).to.equal(500n); // spent
    expect(await readRemaining(keys[1]!.address, tokenAddr, holders[1]!)).to.equal(100n); // untouched
    expect(await readRemaining(keys[2]!.address, tokenAddr, holders[2]!)).to.equal(1000n); // restored

    console.log("\n    indistinguishability:");
    console.log("      path             total gas   calldata gas   zero bytes   EXECUTION gas");
    for (const r of results) {
      console.log(
        `      ${r.label.padEnd(15)} ${String(r.gas).padStart(9)} ` +
          `${String(r.cd).padStart(14)} ${String(r.zeros).padStart(12)} ` +
          `${String(r.exec).padStart(15)}`,
      );
    }

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

    // Everything the contract executes costs exactly the same on all three paths.
    expect(results[1]!.exec).to.equal(results[0]!.exec);
    expect(results[2]!.exec).to.equal(results[0]!.exec);

    // And the residual difference in total gas is fully explained by calldata
    // entropy — assert the attribution closes, so a future execution-side leak
    // cannot hide behind "it's just calldata".
    for (const r of results) {
      expect(r.gas - BigInt(r.cd)).to.equal(results[0]!.exec);
    }
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

    const expiry5 = await future();
    await (
      await module.connect(owner).openSession(
        {
          sessionKey: sessionKey.address,
          expiry: expiry5,
          maxTxCount: 0,
          tokens: [tokenAddr, token2Addr],
          budgets: [enc.handles[0]!, enc.handles[1]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
        await signOpen(sessionKey, owner.address, expiry5, 0),
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
    const expiry8c = await future();
    await expect(
      module.connect(owner).openSession(
        {
          sessionKey: sessionKey.address,
          expiry: expiry8c,
          maxTxCount: 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
        await signOpen(sessionKey, owner.address, expiry8c, 0),
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

  // -------------------------------------------------------------------------
  // B1. The session key must consent. Without this, anyone watching the mempool
  //     could resubmit the same key with more gas, take ownership, and make the
  //     honest call revert with SessionKeyAlreadyUsed — permanently burning the
  //     key, since the single-use invariant never clears `owner`.
  // -------------------------------------------------------------------------
  describe("B1. session key consent", () => {
    let openExpiry: number;

    beforeEach(async () => {
      openExpiry = await future();
    });

    async function attemptOpen(
      opener: HardhatEthersSigner,
      key: HardhatEthersSigner,
      signature: string,
    ) {
      await (await token.connect(deployer).mintPlain(opener.address, 10_000n)).wait();
      await (await token.connect(opener).setOperator(moduleAddr, await future())).wait();
      const enc = await fhevm
        .createEncryptedInput(moduleAddr, opener.address)
        .add64(1000n)
        .encrypt();
      return module.connect(opener).openSession(
        {
          sessionKey: key.address,
          expiry: openExpiry,
          maxTxCount: 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: [recipient.address],
        },
        enc.inputProof,
        signature,
      );
    }

    it("B1a. opens with a valid signature", async () => {
      const sig = await signOpen(sessionKey, owner.address, openExpiry, 0);
      await expect(attemptOpen(owner, sessionKey, sig)).to.emit(module, "SessionOpened");
    });

    it("B1b. a front-runner cannot steal the key: the signature names one owner", async () => {
      // The attacker sees the honest call in the mempool and replays its calldata,
      // signature included, from their own address.
      const honestSig = await signOpen(sessionKey, owner.address, openExpiry, 0);
      await expect(attemptOpen(outsider, sessionKey, honestSig)).to.be.revertedWithCustomError(
        module,
        "InvalidSessionKeySignature",
      );
      // ...and the key is still unused, so the honest open still succeeds.
      await expect(attemptOpen(owner, sessionKey, honestSig)).to.emit(module, "SessionOpened");
    });

    it("B1c. rejects a signature from the wrong signer", async () => {
      const sig = await signOpen(outsider, owner.address, openExpiry, 0);
      await expect(attemptOpen(owner, sessionKey, sig)).to.be.revertedWithCustomError(
        module,
        "InvalidSessionKeySignature",
      );
    });

    it("B1d. rejects a signature bound to a different chainId", async () => {
      const sig = await signOpen(sessionKey, owner.address, openExpiry, 0, { chainId: 1n });
      await expect(attemptOpen(owner, sessionKey, sig)).to.be.revertedWithCustomError(
        module,
        "InvalidSessionKeySignature",
      );
    });

    it("B1e. rejects a signature bound to a different deployment", async () => {
      const other = await (await ethers.getContractFactory("SaveTogetherSession")).deploy();
      const sig = await signOpen(sessionKey, owner.address, openExpiry, 0, {
        verifyingContract: await other.getAddress(),
      });
      await expect(attemptOpen(owner, sessionKey, sig)).to.be.revertedWithCustomError(
        module,
        "InvalidSessionKeySignature",
      );
    });

    it("B1f. the on-chain digest matches what the client signs", async () => {
      const digest = await module.openSessionDigest(
        owner.address,
        sessionKey.address,
        openExpiry,
        0,
      );
      const sig = await signOpen(sessionKey, owner.address, openExpiry, 0);
      expect(ethers.recoverAddress(digest, sig)).to.equal(sessionKey.address);
    });
  });

  // -------------------------------------------------------------------------
  // B2. protocolStatus had no test at all, which is why nobody could be sure it
  //     resolved the ACL correctly. It does: getEthereumCoprocessorConfig
  //     dispatches on chainid, and it is the same function the inherited
  //     ZamaEthereumConfig constructor uses.
  // -------------------------------------------------------------------------
  it("B2. protocolStatus resolves the ACL on this chain and reports sane values", async () => {
    const [aclPaused, keyDenied, moduleDenied] = await module.protocolStatus(sessionKey.address);
    expect(aclPaused).to.equal(false);
    expect(keyDenied).to.equal(false);
    expect(moduleDenied).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // B3. Recipients must be changeable mid-session, or "authorize once, talk all
  //     day" costs a new key, a new delegation and a new batch signature every
  //     time a new payee comes up.
  // -------------------------------------------------------------------------
  describe("B3. recipient management", () => {
    beforeEach(async () => {
      await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    });

    it("B3a. the owner adds a recipient and the session can then send to it", async () => {
      let enc = await encFor(moduleAddr, sessionKey.address, 100n);
      await expect(
        module
          .connect(sessionKey)
          .send(tokenAddr, outsider.address, enc.handles[0]!, enc.inputProof),
      ).to.be.revertedWithCustomError(module, "RecipientNotAllowed");

      await expect(module.connect(owner).addRecipient(sessionKey.address, outsider.address))
        .to.emit(module, "RecipientAdded")
        .withArgs(sessionKey.address, outsider.address);

      enc = await encFor(moduleAddr, sessionKey.address, 100n);
      await (
        await module
          .connect(sessionKey)
          .send(tokenAddr, outsider.address, enc.handles[0]!, enc.inputProof)
      ).wait();
      expect(await readBalance(outsider.address, outsider)).to.equal(100n);
    });

    it("B3b. a non-owner cannot add a recipient", async () => {
      await expect(
        module.connect(outsider).addRecipient(sessionKey.address, outsider.address),
      ).to.be.revertedWithCustomError(module, "NotSessionOwner");
      await expect(
        module.connect(sessionKey).addRecipient(sessionKey.address, outsider.address),
      ).to.be.revertedWithCustomError(module, "NotSessionOwner");
    });

    it("B3c. the session key can remove but not add — it may narrow its own scope", async () => {
      await expect(
        module.connect(sessionKey).removeRecipient(sessionKey.address, recipient.address),
      )
        .to.emit(module, "RecipientRemoved")
        .withArgs(sessionKey.address, recipient.address, sessionKey.address);
      expect(await module.isRecipientAllowed(sessionKey.address, recipient.address)).to.equal(
        false,
      );
    });

    it("B3d. removal blocks a subsequent send", async () => {
      await (
        await module.connect(owner).removeRecipient(sessionKey.address, recipient.address)
      ).wait();
      const enc = await encFor(moduleAddr, sessionKey.address, 100n);
      await expect(
        module
          .connect(sessionKey)
          .send(tokenAddr, recipient.address, enc.handles[0]!, enc.inputProof),
      ).to.be.revertedWithCustomError(module, "RecipientNotAllowed");
    });

    it("B3e. enumeration stays correct across add, remove and re-add", async () => {
      const a = outsider.address;
      const b = deployer.address;
      await (await module.connect(owner).addRecipient(sessionKey.address, a)).wait();
      await (await module.connect(owner).addRecipient(sessionKey.address, b)).wait();
      expect(await module.recipientsOf(sessionKey.address)).to.deep.equal([
        recipient.address,
        a,
        b,
      ]);

      // Remove the middle element: swap-and-pop moves the last into its slot.
      await (await module.connect(owner).removeRecipient(sessionKey.address, a)).wait();
      expect(await module.recipientsOf(sessionKey.address)).to.deep.equal([recipient.address, b]);
      expect(await module.isRecipientAllowed(sessionKey.address, a)).to.equal(false);
      expect(await module.isRecipientAllowed(sessionKey.address, b)).to.equal(true);

      // Removing the moved element must still work, i.e. its index was fixed up.
      await (await module.connect(owner).removeRecipient(sessionKey.address, b)).wait();
      expect(await module.recipientsOf(sessionKey.address)).to.deep.equal([recipient.address]);

      await (await module.connect(owner).addRecipient(sessionKey.address, a)).wait();
      expect(await module.recipientsOf(sessionKey.address)).to.deep.equal([recipient.address, a]);
    });

    it("B3f. rejects a duplicate add and a removal of an absent recipient", async () => {
      await expect(
        module.connect(owner).addRecipient(sessionKey.address, recipient.address),
      ).to.be.revertedWithCustomError(module, "RecipientAlreadyAllowed");
      await expect(
        module.connect(owner).removeRecipient(sessionKey.address, outsider.address),
      ).to.be.revertedWithCustomError(module, "RecipientNotInSession");
    });
  });

  // -------------------------------------------------------------------------
  // B4. Minor guards
  // -------------------------------------------------------------------------
  it("B4a. refuses to top up an expired session", async () => {
    await openBasicSession(owner, sessionKey, { balance: 10_000n, budget: 1000n });
    await ethers.provider.send("evm_increaseTime", [8 * DAY]);
    await ethers.provider.send("evm_mine", []);

    const enc = await fhevm.createEncryptedInput(moduleAddr, owner.address).add64(500n).encrypt();
    await expect(
      module
        .connect(owner)
        .increaseBudget(sessionKey.address, tokenAddr, enc.handles[0]!, enc.inputProof),
    ).to.be.revertedWithCustomError(module, "SessionExpired");
  });

  it("B4b. caps the allowlist so the session cannot make its own views uncallable", async () => {
    const cap = Number(await module.MAX_RECIPIENTS());
    const many = Array.from({ length: cap + 1 }, (_, i) =>
      ethers.getAddress("0x" + (i + 1).toString(16).padStart(40, "0")),
    );
    const enc = await fhevm.createEncryptedInput(moduleAddr, owner.address).add64(1n).encrypt();
    const expiry = await future();
    await expect(
      module.connect(owner).openSession(
        {
          sessionKey: sessionKey.address,
          expiry,
          maxTxCount: 0,
          tokens: [tokenAddr],
          budgets: [enc.handles[0]!],
          recipients: many,
        },
        enc.inputProof,
        await signOpen(sessionKey, owner.address, expiry, 0),
      ),
    ).to.be.revertedWithCustomError(module, "TooManyRecipients");
  });
});
