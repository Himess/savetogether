/**
 * Session records, and the session keys themselves.
 *
 * WHAT THIS HOLDS. One private key per live session, encrypted at rest, plus
 * public bookkeeping: the owner's address, the module, the token list, the
 * expiry, and the bearer token that addresses the MCP endpoint. Nothing else is
 * secret, and nothing here is a vault key — the server has never seen one and
 * has no code path that could accept one.
 *
 * WHAT PROTECTS IT. Not this file. A session key is bounded on chain by an
 * encrypted budget nobody can read, an allowlist of recipients, and an expiry,
 * and the owner can close it unilaterally from their own wallet. Encryption at
 * rest is the second lock, not the first — and it is worth saying plainly that a
 * server compromised while running can spend up to the remaining budget, to the
 * allowlisted addresses, until the owner revokes.
 *
 * THE MASTER KEY is read from `GHOSTPOOL_MASTER_KEY` (64 hex characters). With
 * none set, one is generated into `~/.ghostpool-hosted/master.key` at 0600 and
 * the path is logged loudly. It is never written into the repository, and the
 * store refuses to start if it finds itself inside a git working tree.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionRecord {
  /** Addresses the MCP endpoint. Bearer credential; treat as a password. */
  readonly token: string;
  readonly sessionKeyAddress: string;
  readonly ownerAddress: string;
  readonly moduleAddress: string;
  readonly tokens: readonly string[];
  readonly readScope: "spend-only" | "balance-visible";
  /** UNIX seconds. The chain is the authority; this is for cheap filtering. */
  readonly expiry: number;
  readonly createdAt: number;
  /** True once the chain confirmed the owner. Nothing is served before that. */
  readonly adopted: boolean;
  /** Rate limiting, per session. */
  callCount: number;
  windowStart: number;
}

const DEFAULT_DIR = path.join(os.homedir(), ".ghostpool-hosted");

/** AES-256-GCM. The nonce is stored beside the ciphertext, which is its job. */
function seal(masterKey: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), body.toString("hex")].join(".");
}

function open(masterKey: Buffer, sealed: string): string {
  const [ivHex = "", tagHex = "", bodyHex = ""] = sealed.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Refuses to run inside a checkout.
 *
 * The failure this prevents is not exotic: a developer points the store at the
 * project directory for convenience, and session keys land in `git status`.
 */
async function refuseIfInsideRepo(dir: string): Promise<void> {
  let cursor = path.resolve(dir);
  for (;;) {
    try {
      await fs.stat(path.join(cursor, ".git"));
      throw new Error(
        `refusing to store session keys inside a git working tree (${cursor}). ` +
          `Set GHOSTPOOL_STORE_DIR to somewhere outside the repository.`,
      );
    } catch (e) {
      if ((e as Error).message.startsWith("refusing")) throw e;
    }
    const up = path.dirname(cursor);
    if (up === cursor) return;
    cursor = up;
  }
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();
  private keys = new Map<string, string>(); // address -> sealed private key
  private masterKey: Buffer | null = null;

  constructor(private readonly dir: string = process.env["GHOSTPOOL_STORE_DIR"] ?? DEFAULT_DIR) {}

  async init(): Promise<{ masterKeySource: string }> {
    await refuseIfInsideRepo(this.dir);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });

    const fromEnv = process.env["GHOSTPOOL_MASTER_KEY"];
    let source: string;
    if (fromEnv !== undefined && fromEnv !== "") {
      if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
        throw new Error("GHOSTPOOL_MASTER_KEY must be 64 hex characters");
      }
      this.masterKey = Buffer.from(fromEnv, "hex");
      source = "GHOSTPOOL_MASTER_KEY";
    } else {
      const file = path.join(this.dir, "master.key");
      try {
        this.masterKey = Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
        source = file;
      } catch {
        const fresh = crypto.randomBytes(32);
        await fs.writeFile(file, fresh.toString("hex"), { mode: 0o600 });
        this.masterKey = fresh;
        source = `${file} (generated)`;
      }
    }

    await this.load();
    return { masterKeySource: source };
  }

  private get file(): string {
    return path.join(this.dir, "sessions.json");
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as {
        records: SessionRecord[];
        keys: Record<string, string>;
      };
      for (const r of raw.records) this.records.set(r.token, r);
      for (const [a, k] of Object.entries(raw.keys)) this.keys.set(a, k);
    } catch {
      // A missing store is the ordinary first run, not an error.
    }
  }

  private async flush(): Promise<void> {
    await fs.writeFile(
      this.file,
      JSON.stringify(
        { records: [...this.records.values()], keys: Object.fromEntries(this.keys) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  /** Stores a freshly generated key. The plaintext is not returned or logged. */
  async putKey(address: string, privateKey: string): Promise<void> {
    if (this.masterKey === null) throw new Error("store not initialised");
    this.keys.set(address.toLowerCase(), seal(this.masterKey, privateKey));
    await this.flush();
  }

  async getKey(address: string): Promise<string> {
    if (this.masterKey === null) throw new Error("store not initialised");
    const sealed = this.keys.get(address.toLowerCase());
    if (sealed === undefined) throw new Error(`no session key held for ${address}`);
    return open(this.masterKey, sealed);
  }

  async put(record: SessionRecord): Promise<void> {
    this.records.set(record.token, record);
    await this.flush();
  }

  get(token: string): SessionRecord | undefined {
    return this.records.get(token);
  }

  bySessionKey(address: string): SessionRecord | undefined {
    const needle = address.toLowerCase();
    for (const r of this.records.values()) {
      if (r.sessionKeyAddress.toLowerCase() === needle) return r;
    }
    return undefined;
  }

  /**
   * Forgets a session and destroys its key.
   *
   * This is housekeeping, not security: the chain already stopped the key when
   * the owner closed the session. Destroying it here means a later compromise of
   * the store cannot reach a key that is no longer useful anyway.
   */
  async forget(token: string): Promise<boolean> {
    const record = this.records.get(token);
    if (record === undefined) return false;
    this.records.delete(token);
    this.keys.delete(record.sessionKeyAddress.toLowerCase());
    await this.flush();
    return true;
  }

  /** Drops everything past its expiry. The chain enforces it; this tidies up. */
  async sweep(now = Math.floor(Date.now() / 1000)): Promise<number> {
    let n = 0;
    for (const [token, r] of [...this.records]) {
      if (r.expiry <= now) {
        await this.forget(token);
        n += 1;
      }
    }
    return n;
  }

  all(): readonly SessionRecord[] {
    return [...this.records.values()];
  }
}
