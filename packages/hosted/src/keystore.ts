/**
 * The SDK's keystore interface, backed by the server's store.
 *
 * The SDK already takes a `SessionKeystore`, so hosting needs no change to how a
 * session is opened — only a different place for the key to live. Locally that
 * is the OS keychain; here it is an AES-GCM blob under a master key the process
 * holds. The interface is the seam that made this a swap rather than a fork.
 */
import type { SessionKeystore, StoredSessionKey } from "@ghostkey/sdk";
import { Wallet } from "ethers";

import type { SessionStore } from "./store";

export class ServerKeystore implements SessionKeystore {
  private labels = new Map<string, { label: string; createdAt: string }>();

  constructor(private readonly store: SessionStore) {}

  /**
   * Generates a key and hands back only the address.
   *
   * The private key exists as a string for the length of this function and is
   * sealed before it is returned from. Nothing logs it, and there is no accessor
   * that returns it in the clear.
   */
  async create(label: string): Promise<string> {
    const wallet = Wallet.createRandom();
    await this.store.putKey(wallet.address, wallet.privateKey);
    this.labels.set(wallet.address.toLowerCase(), {
      label,
      createdAt: new Date().toISOString(),
    });
    return wallet.address;
  }

  async load(address: string): Promise<Wallet> {
    return new Wallet(await this.store.getKey(address));
  }

  async list(): Promise<readonly StoredSessionKey[]> {
    return this.store.all().map((r) => ({
      address: r.sessionKeyAddress,
      label: this.labels.get(r.sessionKeyAddress.toLowerCase())?.label ?? "hosted session",
      createdAt:
        this.labels.get(r.sessionKeyAddress.toLowerCase())?.createdAt ??
        new Date(r.createdAt * 1000).toISOString(),
      // There is no file for one key here; they share a sealed store. Saying so
      // beats inventing a path that nobody could open.
      file: "(sealed in the hosted session store)",
    }));
  }

  async destroy(address: string): Promise<void> {
    const record = this.store.bySessionKey(address);
    if (record !== undefined) await this.store.forget(record.token);
  }
}
