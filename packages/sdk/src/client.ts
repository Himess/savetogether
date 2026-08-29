/**
 * The client: opening a session, and resuming one that already exists.
 *
 * ON "ONE SIGNATURE". Opening a session needs three owner-side actions —
 * `setOperator` per token, `openSession`, and, only for the balance-visible tier,
 * `delegateForUserDecryption` per token. There are two honest ways to make that
 * one authorisation, and both are implemented here because they serve different
 * callers:
 *
 *   - a consumer with a browser wallet gets them batched into one approval via
 *     EIP-5792 `wallet_sendCalls`, when the wallet advertises the capability;
 *   - the GhostKey product has no browser wallet — both keys are local — so
 *     "one signature" means ONE VAULT UNLOCK, after which the local owner key
 *     signs the three transactions in sequence without asking again.
 *
 * The fallback is not a degraded path. For the product it is the path.
 */
import { parseEther, recoverAddress, type Provider, type Signer } from "ethers";

import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, OPEN_SESSION_TYPES } from "./abi";
import { acl as aclAt, erc7984, ghostKey } from "./contracts";
import { createFhevm, encryptMany, type FhevmInstance, SEPOLIA_ACL_ADDRESS } from "./fhe";
import { type SessionKeystore } from "./keystore";
import {
  BalanceVisibleSession,
  type Session,
  type SessionContext,
  SpendOnlySession,
} from "./session";

/**
 * Gas forwarded to a freshly generated session key, unless the caller says otherwise.
 *
 * The session key sends its own transactions — that is what makes it a session key
 * rather than a signature scheme — so it needs gas, and the only moment the owner
 * is authorised is during the open. Leaving this to every consumer is a footgun:
 * the first integration test written against this SDK forgot it, and the failure
 * surfaces as an opaque "insufficient funds" from inside `send`, minutes later.
 *
 * About 0.02 ETH is twenty-odd confidential transfers at Sepolia gas prices.
 */
export const DEFAULT_SESSION_GAS = parseEther("0.02");

/** Which privacy tier a session runs in. Chosen at open; it is not a runtime flag. */
export type ReadScope = "spend-only" | "balance-visible";

export interface GhostKeyClientConfig {
  readonly provider: Provider;
  readonly rpcUrl: string;
  readonly moduleAddress: string;
  readonly keystore: SessionKeystore;
  /** Defaults to the ACL address the relayer SDK ships for Sepolia. */
  readonly aclAddress?: string;
  readonly chainId?: number;
}

export interface OpenSessionRequest {
  /** The vault key. Unlocked for this call and locked again afterwards. */
  readonly owner: Signer;
  readonly budgets: ReadonlyArray<{ token: string; amount: bigint }>;
  readonly recipients: readonly string[];
  readonly expiry: Date;
  readonly maxTxCount?: number;
  readonly readScope: ReadScope;
  /** Label recorded in the keystore metadata. */
  readonly label?: string;
  /**
   * Gas to forward to the session key. Defaults to {@link DEFAULT_SESSION_GAS}.
   * Pass 0n to fund it yourself — the session key cannot send without gas.
   */
  readonly gasForSessionKey?: bigint;
}

export interface OpenSessionResult {
  readonly session: Session;
  readonly sessionKeyAddress: string;
  /** Transaction hashes in submission order. */
  readonly hashes: readonly string[];
  /** True when EIP-5792 batching was available and used. */
  readonly batched: boolean;
  /** Gas actually forwarded to the session key. Zero if it already had enough. */
  readonly gasForwarded: bigint;
  /**
   * How many times the owner had to authorise. One when batched; one when the
   * vault is unlocked once and signs locally. Higher only if a caller supplies a
   * signer that prompts per transaction.
   */
  readonly ownerAuthorisations: number;
}

export class GhostKeyClient {
  private fhevmPromise: Promise<FhevmInstance> | null = null;

  constructor(readonly config: GhostKeyClientConfig) {}

  private fhevm(): Promise<FhevmInstance> {
    this.fhevmPromise ??= createFhevm(this.config.rpcUrl);
    return this.fhevmPromise;
  }

  private get acl(): string {
    return this.config.aclAddress ?? SEPOLIA_ACL_ADDRESS;
  }

  /** Opens a session. Generates the session key locally; it never leaves the process. */
  async openSession(req: OpenSessionRequest): Promise<OpenSessionResult> {
    if (req.budgets.length === 0) throw new Error("a session must fund at least one token");
    if (req.recipients.length === 0) {
      throw new Error(
        "a session must allow at least one recipient: an empty allowlist means no transfers",
      );
    }

    const fhevm = await this.fhevm();
    const ownerAddress = await req.owner.getAddress();
    const expiry = Math.floor(req.expiry.getTime() / 1000);
    const maxTxCount = req.maxTxCount ?? 0;

    const sessionKeyAddress = await this.config.keystore.create(
      req.label ?? `ghostkey-${new Date().toISOString()}`,
    );
    const sessionKey = (await this.config.keystore.load(sessionKeyAddress)).connect(
      this.config.provider,
    );

    // Every budget under ONE createEncryptedInput and ONE proof. This is what
    // keeps a multi-token open to a single call rather than one per token.
    const tokens = req.budgets.map((b) => b.token);
    const { handles, inputProof } = await encryptMany(
      fhevm,
      this.config.moduleAddress,
      ownerAddress,
      req.budgets.map((b) => b.amount),
    );

    // The session key consents by signature, which is what stops anyone from
    // front-running the open with the same key and burning it permanently. The
    // digest comes from the contract view rather than being rebuilt here, so the
    // two can never drift apart.
    const moduleRead = ghostKey(this.config.moduleAddress, this.config.provider);
    const digest = await moduleRead.openSessionDigest(
      ownerAddress,
      sessionKeyAddress,
      expiry,
      maxTxCount,
    );
    const chainId =
      this.config.chainId ?? Number((await this.config.provider.getNetwork()).chainId);
    const signature = await sessionKey.signTypedData(
      {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId,
        verifyingContract: this.config.moduleAddress,
      },
      OPEN_SESSION_TYPES as unknown as Record<string, { name: string; type: string }[]>,
      { owner: ownerAddress, sessionKey: sessionKeyAddress, expiry, maxTxCount },
    );
    // Cheap insurance against a domain mismatch: the contract's own digest must
    // be what we signed. Test B1f covers this on chain; this catches it earlier.
    if (recoverAddress(digest, signature).toLowerCase() !== sessionKeyAddress.toLowerCase()) {
      throw new Error("the session-key signature does not recover against the contract's digest");
    }

    const moduleIface = moduleRead.interface;
    const ercIface = erc7984(tokens[0]!, this.config.provider).interface;
    const aclIface = aclAt(this.acl, this.config.provider).interface;

    const calls: { to: string; data: string }[] = [];
    for (const t of tokens) {
      calls.push({
        to: t,
        data: ercIface.encodeFunctionData("setOperator", [this.config.moduleAddress, expiry]),
      });
    }
    calls.push({
      to: this.config.moduleAddress,
      data: moduleIface.encodeFunctionData("openSession", [
        {
          sessionKey: sessionKeyAddress,
          expiry,
          maxTxCount,
          tokens,
          budgets: handles,
          // The session key is always on its own allowlist. It is the address
          // the pool position is held under, and `send` to it is how the owner
          // funds a deposit — bounded by the encrypted budget like any other
          // spend. Leaving it off would make entering the pool cost a second
          // vault unlock via addRecipient, which is the whole thing this
          // product exists to avoid.
          recipients: [...new Set([...req.recipients, sessionKeyAddress])],
        },
        inputProof,
        signature,
      ]),
    });

    // Delegation is the balance-visible tier's one extra action. The ACL takes the
    // singular form only — the array form is absent from the deployed bytecode —
    // so several tokens go through multicall rather than a batch entrypoint.
    if (req.readScope === "balance-visible") {
      if (tokens.length === 1) {
        calls.push({
          to: this.acl,
          data: aclIface.encodeFunctionData("delegateForUserDecryption", [
            sessionKeyAddress,
            tokens[0]!,
            expiry,
          ]),
        });
      } else {
        const inner = tokens.map((t) =>
          aclIface.encodeFunctionData("delegateForUserDecryption", [sessionKeyAddress, t, expiry]),
        );
        calls.push({ to: this.acl, data: aclIface.encodeFunctionData("multicall", [inner]) });
      }
    }

    const { hashes, batched, authorisations } = await submitOwnerCalls(req.owner, calls, chainId);

    // Fund the session key while the owner is still authorised. Doing it here
    // rather than leaving it to the caller is the difference between a session
    // that works and one that fails opaquely on its first send.
    const target = req.gasForSessionKey ?? DEFAULT_SESSION_GAS;
    let gasForwarded = 0n;
    if (target > 0n) {
      const balance = await this.config.provider.getBalance(sessionKeyAddress);
      if (balance < target / 2n) {
        const top = target - balance;
        const tx = await req.owner.sendTransaction({ to: sessionKeyAddress, value: top });
        await tx.wait();
        hashes.push(tx.hash);
        gasForwarded = top;
      }
    }

    const ctx: SessionContext = {
      moduleAddress: this.config.moduleAddress,
      sessionKey,
      sessionKeyAddress,
      owner: ownerAddress,
      fhevm,
    };
    const session =
      req.readScope === "balance-visible"
        ? new BalanceVisibleSession(ctx)
        : new SpendOnlySession(ctx);

    return {
      session,
      sessionKeyAddress,
      hashes,
      batched,
      gasForwarded,
      ownerAuthorisations: authorisations,
    };
  }

  /** Rebuilds a session object for a key already in the keystore. */
  async resumeSession(sessionKeyAddress: string, readScope: ReadScope): Promise<Session> {
    const fhevm = await this.fhevm();
    const sessionKey = (await this.config.keystore.load(sessionKeyAddress)).connect(
      this.config.provider,
    );
    const moduleRead = ghostKey(this.config.moduleAddress, this.config.provider);
    const params = await moduleRead.sessionOf(sessionKeyAddress);
    const ctx: SessionContext = {
      moduleAddress: this.config.moduleAddress,
      sessionKey,
      sessionKeyAddress,
      owner: params[0],
      fhevm,
    };
    return readScope === "balance-visible"
      ? new BalanceVisibleSession(ctx)
      : new SpendOnlySession(ctx);
  }

  /** Revokes balance visibility without closing the session. */
  async revokeBalanceAccess(
    owner: Signer,
    sessionKeyAddress: string,
    tokens: readonly string[],
  ): Promise<readonly string[]> {
    const contract = aclAt(this.acl, owner);
    const hashes: string[] = [];
    for (const t of tokens) {
      const tx = await contract.revokeDelegationForUserDecryption(sessionKeyAddress, t);
      await tx.wait();
      hashes.push(tx.hash);
    }
    return hashes;
  }
}

/**
 * Submits the owner's calls, batched when the signer sits behind a wallet that
 * supports EIP-5792 and sequentially otherwise.
 *
 * `authorisations` reports what actually happened, so a caller can render an
 * honest count rather than an aspirational one. Note what it counts:
 * AUTHORISATIONS, not signatures. A local vault key signs three transactions
 * after one unlock, and the unlock is the thing the user experiences.
 */
async function submitOwnerCalls(
  owner: Signer,
  calls: readonly { to: string; data: string }[],
  chainId: number,
): Promise<{ hashes: string[]; batched: boolean; authorisations: number }> {
  const provider = owner.provider as
    (Provider & { send?: (m: string, p: unknown[]) => Promise<unknown> }) | null;
  const from = await owner.getAddress();

  if (provider?.send !== undefined) {
    try {
      const caps = (await provider.send("wallet_getCapabilities", [from])) as Record<
        string,
        { atomicBatch?: { supported?: boolean }; atomic?: { status?: string } }
      >;
      const key = `0x${chainId.toString(16)}`;
      const cap = caps[key];
      const supported =
        cap?.atomicBatch?.supported === true ||
        cap?.atomic?.status === "supported" ||
        cap?.atomic?.status === "ready";
      if (supported) {
        const id = (await provider.send("wallet_sendCalls", [
          {
            version: "2.0.0",
            from,
            chainId: key,
            calls: calls.map((c) => ({ to: c.to, data: c.data })),
          },
        ])) as string | { id: string };
        return {
          hashes: [typeof id === "string" ? id : id.id] as string[],
          batched: true,
          authorisations: 1,
        };
      }
    } catch {
      // A wallet that does not implement the method throws rather than returning
      // empty capabilities. That is the common case, and it is not an error.
    }
  }

  // Sequential. For the product this is the path: the vault is unlocked once and
  // the local key signs each call without prompting again, so this is still one
  // authorisation from the user's point of view.
  const hashes: string[] = [];
  for (const c of calls) {
    const tx = await owner.sendTransaction({ to: c.to, data: c.data });
    await tx.wait();
    hashes.push(tx.hash);
  }
  return { hashes, batched: false, authorisations: 1 };
}
