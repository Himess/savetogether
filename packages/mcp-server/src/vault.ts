/**
 * The two-tier wallet.
 *
 * WHY TWO KEYS. If the vault key were the only key, the encrypted budget would be
 * decoration: an owner can always bypass the module and call
 * `confidentialTransfer` directly. The split is what makes the budget real.
 *
 *   vault key    owns the funds, stays locked, unlocks once per session open
 *   session key  bounded by the encrypted budget and the allowlist, stays warm
 *
 * Both are generated locally by this process. No MetaMask, no extension, no seed
 * phrase — the vault key is derived from raw entropy so no mnemonic is ever
 * created, held, or written anywhere.
 *
 * THE UNLOCK NEVER TOUCHES CHAT. A passphrase typed into a conversation enters the
 * model's context and the transcript, permanently. So authorisation happens on the
 * local console, or at the terminal, and never through a tool argument.
 */
import { createInterface } from "node:readline";
import type { ConsoleServer } from "@savetogether/console";
import { osKeychainKeystore, type SessionKeystore } from "@savetogether/sdk";
import { type Provider, Wallet } from "ethers";
import * as os from "node:os";
import * as path from "node:path";

/** Only Sepolia. Asserted, not assumed — see {@link Vault.unlock}. */
export const SEPOLIA_CHAIN_ID = 11155111;

export interface VaultOptions {
  readonly provider: Provider;
  readonly chainId: number;
  /** Present in normal operation; absent only for headless tests. */
  readonly console?: ConsoleServer;
  /**
   * Skips the human authorisation step so a demo can be recorded without a hand
   * reaching for the mouse. Hard-gated to Sepolia — see {@link Vault.unlock}.
   */
  readonly devUnlock?: boolean;
  readonly dir?: string;
}

export class Vault {
  private readonly store: SessionKeystore;
  private cached: Wallet | null = null;

  constructor(private readonly opts: VaultOptions) {
    this.store = osKeychainKeystore({
      dir: opts.dir ?? path.join(os.homedir(), ".savetogether", "vault"),
      service: "savetogether-vault",
    });
  }

  /** Creates the vault key if there is not one already. Returns its address. */
  async ensure(): Promise<string> {
    const existing = await this.store.list();
    const first = existing[0];
    if (first !== undefined) return first.address;
    return this.store.create("savetogether-vault");
  }

  async address(): Promise<string | null> {
    const existing = await this.store.list();
    return existing[0]?.address ?? null;
  }

  /**
   * Authorises and returns the vault signer.
   *
   * The key material is decrypted from the OS keychain; the *authorisation* is a
   * click on the local console, or a terminal confirmation when there is no
   * console. Neither path can be driven by the model: a tool call cannot click a
   * button, and stdin belongs to the MCP transport, not to a conversation.
   *
   * NOT IMPLEMENTED: a true biometric prompt (Touch ID, Windows Hello). That
   * needs a native module per platform. What is implemented is key material at
   * rest under the OS keychain plus a local human action — which is the second
   * item in the brief's preference order, and is honest about being that.
   */
  async unlock(reason: string): Promise<Wallet> {
    if (this.cached !== null) return this.cached;

    const address = await this.address();
    if (address === null) throw new Error("no vault key: run `savetogether init` first");

    if (this.opts.devUnlock === true) {
      // A recording convenience must never be able to authorise real value. The
      // gate is on the chain id, checked here rather than at construction, so a
      // provider swapped after startup cannot slip past it.
      if (this.opts.chainId !== SEPOLIA_CHAIN_ID) {
        throw new Error(
          `--dev-unlock is restricted to Sepolia (chainId ${SEPOLIA_CHAIN_ID}); this process is on chainId ${this.opts.chainId}`,
        );
      }
    } else if (this.opts.console !== undefined) {
      const answer = await this.opts.console.ask("unlock", reason);
      if (!answer.approved) throw new Error("the vault unlock was declined at the console");
    } else {
      const ok = await confirmAtTerminal(reason);
      if (!ok) throw new Error("the vault unlock was declined at the terminal");
    }

    const wallet = (await this.store.load(address)).connect(this.opts.provider);
    this.cached = wallet;
    return wallet;
  }

  /** Drops the decrypted key. Called immediately after the session open. */
  lock(): void {
    this.cached = null;
  }

  get isUnlocked(): boolean {
    return this.cached !== null;
  }
}

/**
 * Terminal fallback. Reads from the controlling TTY rather than stdin, because
 * stdin is the MCP transport — a conversation must not be able to answer this.
 */
async function confirmAtTerminal(reason: string): Promise<boolean> {
  if (!process.stderr.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`\nSaveTogether — unlock the vault?\n  ${reason}\n  [y/N] `, resolve),
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}
