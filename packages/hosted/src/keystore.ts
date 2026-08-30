/**
 * The SDK's keystore interface, held in memory for the length of a request.
 *
 * The SDK already takes a `SessionKeystore`, so hosting needed no change to how
 * a session is opened — only a different place for the key to live. Locally that
 * is the OS keychain. Here it is nowhere: the key is generated during `prepare`,
 * sealed into the bearer token, and forgotten. On a later request it comes back
 * out of the token the caller presented, is used, and is forgotten again.
 *
 * That is what makes the server disposable. There is no file of private keys to
 * move between hosts, back up, or leak, and a restart costs nothing because
 * nothing was being kept.
 */
import type { SessionKeystore, StoredSessionKey } from "@ghostkey/sdk";
import { Wallet } from "ethers";

export class MemoryKeystore implements SessionKeystore {
  private readonly keys = new Map<string, string>();

  /** Generates a key. The caller is expected to seal it and then forget it. */
  async create(_label: string): Promise<string> {
    const wallet = Wallet.createRandom();
    this.keys.set(wallet.address.toLowerCase(), wallet.privateKey);
    return wallet.address;
  }

  /** Puts a key back, from a token the caller presented. */
  put(address: string, privateKey: string): void {
    this.keys.set(address.toLowerCase(), privateKey);
  }

  async load(address: string): Promise<Wallet> {
    const key = this.keys.get(address.toLowerCase());
    if (key === undefined) {
      throw new Error(`no session key in memory for ${address}`);
    }
    return new Wallet(key);
  }

  /**
   * Drops a key once the caller has what it needs.
   *
   * Without this the map is an ever-growing pile of private keys in a long-lived
   * process, which is the exact thing this design set out not to have.
   */
  forget(address: string): void {
    this.keys.delete(address.toLowerCase());
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    return [];
  }

  async destroy(address: string): Promise<void> {
    this.forget(address);
  }
}
