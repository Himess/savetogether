/**
 * Session key custody.
 *
 * The session key is designed to be leakable — a leak costs at most the remaining
 * encrypted budget, to addresses already on the allowlist, until the session
 * expires. That is a bounded-loss argument, not licence to be careless, so the key
 * is encrypted at rest with a passphrase held in the operating system's keychain,
 * and never appears in an environment variable, a config file, or a log line.
 *
 * ON THE FORMAT. The brief asked for EIP-2335. EIP-2335 is the eth2 keystore, and
 * it specifies BLS12-381 secret keys; a session key here is a secp256k1 EOA key,
 * for which the corresponding standard is Web3 Secret Storage v3 — the format
 * ethers reads and writes natively, scrypt-based, and the one every EVM tool can
 * open. Using it means not hand-rolling key derivation, which is the part of this
 * file where a mistake would be worst. Recorded as a deliberate substitution
 * rather than a silent one.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  HDNodeWallet,
  Wallet,
  decryptKeystoreJson,
  encryptKeystoreJson,
  randomBytes,
} from "ethers";

import { KeystoreError } from "./errors";

const run = promisify(execFile);

export interface StoredSessionKey {
  readonly address: string;
  readonly label: string;
  readonly createdAt: string;
  readonly file: string;
}

export interface SessionKeystore {
  /** Generates a key, encrypts it, stores the passphrase. Returns only the address. */
  create(label: string): Promise<string>;
  /** Decrypts into an in-memory wallet. The plaintext key never touches disk. */
  load(address: string): Promise<Wallet>;
  list(): Promise<readonly StoredSessionKey[]>;
  destroy(address: string): Promise<void>;
}

/** Where the passphrase lives. Never the filesystem, never an env var. */
interface SecretStore {
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
  readonly kind: string;
}

/**
 * macOS Keychain. `security` reads the password from stdin-free argv, which is
 * visible in the process table for an instant; acceptable for a testnet session
 * key, and flagged rather than hidden.
 */
function macKeychain(service: string): SecretStore {
  return {
    kind: "macos-keychain",
    async set(account, secret) {
      await run("security", [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-w",
        secret,
      ]);
    },
    async get(account) {
      try {
        const { stdout } = await run("security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w",
        ]);
        return stdout.trim();
      } catch {
        return null;
      }
    },
    async remove(account) {
      try {
        await run("security", ["delete-generic-password", "-s", service, "-a", account]);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Linux Secret Service via libsecret. */
function secretTool(service: string): SecretStore {
  return {
    kind: "libsecret",
    async set(account, secret) {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "secret-tool",
          ["store", "--label", `${service}:${account}`, "service", service, "account", account],
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.end(secret);
      });
    },
    async get(account) {
      try {
        const { stdout } = await run("secret-tool", [
          "lookup",
          "service",
          service,
          "account",
          account,
        ]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    async remove(account) {
      try {
        await run("secret-tool", ["clear", "service", service, "account", account]);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Windows DPAPI through PowerShell. The ciphertext is bound to the current user
 * account, so a copied file is useless on another machine or under another user.
 * The passphrase is passed on stdin, never on the command line.
 */
function windowsDpapi(service: string, dir: string): SecretStore {
  const file = (account: string) => path.join(dir, `${service}.${account.toLowerCase()}.dpapi`);
  return {
    kind: "windows-dpapi",
    async set(account, secret) {
      const target = file(account);
      const script =
        `$s=[Console]::In.ReadToEnd().Trim(); ` +
        `$e=ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString; ` +
        // -NoNewline so the file holds exactly the blob and nothing else.
        `Set-Content -Path '${target.replace(/'/g, "''")}' -Value $e -Encoding ascii -NoNewline`;
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.end(secret);
      });
    },
    async get(account) {
      const target = file(account);
      try {
        await fs.access(target);
      } catch {
        return null;
      }
      // .Trim() is load-bearing. Set-Content used to append a newline, Get-Content
      // -Raw returned it, and ConvertTo-SecureString rejected the result — which
      // surfaced as "no passphrase found", making a perfectly recoverable key look
      // like a missing one. Every vault created on Windows was unopenable, and
      // nothing tested this path until it was tried by hand.
      const script =
        `$e=(Get-Content -Path '${target.replace(/'/g, "''")}' -Raw).Trim(); ` +
        `$s=ConvertTo-SecureString $e; ` +
        `[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;
      let stdout: string;
      try {
        ({ stdout } = await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]));
      } catch (e) {
        // The file exists but will not decrypt: wrong Windows user, wrong machine,
        // or a corrupted blob. That is not "not stored", and reporting it as such
        // sends the caller off to create another key it will also be unable to open.
        throw new KeystoreError(
          `the passphrase for ${account} exists at ${target} but could not be decrypted — ` +
            `DPAPI blobs are bound to the Windows user that wrote them (${(e as Error).message.slice(0, 120)})`,
        );
      }
      const value = stdout.trim();
      if (value === "") {
        throw new KeystoreError(`the passphrase store returned nothing for ${account}`);
      }
      return value;
    },
    async remove(account) {
      await fs.rm(file(account), { force: true });
    },
  };
}

function pickSecretStore(service: string, dir: string): SecretStore {
  switch (process.platform) {
    case "darwin":
      return macKeychain(service);
    case "win32":
      return windowsDpapi(service, dir);
    default:
      return secretTool(service);
  }
}

/** Default keystore: Web3 Secret Storage v3 on disk, passphrase in the OS keychain. */
export function osKeychainKeystore(opts?: { dir?: string; service?: string }): SessionKeystore {
  const dir = opts?.dir ?? path.join(os.homedir(), ".ghostkey", "keys");
  const service = opts?.service ?? "ghostkey-session";
  const secrets = pickSecretStore(service, dir);

  const fileFor = (address: string) => path.join(dir, `${address.toLowerCase()}.json`);
  const metaFor = (address: string) => path.join(dir, `${address.toLowerCase()}.meta.json`);

  return {
    async create(label) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });

      // From raw entropy rather than createRandom(), so no mnemonic is ever
      // derived, held, or written. The brief is explicit: no seed phrase.
      const wallet = new Wallet(hexlifyBytes(randomBytes(32)));
      const passphrase = hexlifyBytes(randomBytes(32));

      const json = await encryptKeystoreJson(
        { address: wallet.address, privateKey: wallet.privateKey },
        passphrase,
      );
      await fs.writeFile(fileFor(wallet.address), json, { mode: 0o600 });
      await fs.writeFile(
        metaFor(wallet.address),
        JSON.stringify(
          { address: wallet.address, label, createdAt: new Date().toISOString() },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await secrets.set(wallet.address.toLowerCase(), passphrase);
      return wallet.address;
    },

    async load(address) {
      const passphrase = await secrets.get(address.toLowerCase());
      if (passphrase === null) {
        throw new KeystoreError(
          `no passphrase for ${address} in the ${secrets.kind} store; the key cannot be decrypted`,
        );
      }
      let json: string;
      try {
        json = await fs.readFile(fileFor(address), "utf8");
      } catch {
        throw new KeystoreError(`no keystore file for ${address} under ${dir}`);
      }
      const account = await decryptKeystoreJson(json, passphrase);
      const wallet = new Wallet(account.privateKey);
      if (wallet.address.toLowerCase() !== address.toLowerCase()) {
        throw new KeystoreError(`keystore for ${address} decrypts to ${wallet.address}`);
      }
      return wallet;
    },

    async list() {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return [];
      }
      const out: StoredSessionKey[] = [];
      for (const n of names) {
        if (!n.endsWith(".meta.json")) continue;
        try {
          const meta = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as {
            address: string;
            label: string;
            createdAt: string;
          };
          out.push({ ...meta, file: fileFor(meta.address) });
        } catch {
          /* skip unreadable metadata rather than failing the whole listing */
        }
      }
      return out;
    },

    async destroy(address) {
      await fs.rm(fileFor(address), { force: true });
      await fs.rm(metaFor(address), { force: true });
      await secrets.remove(address.toLowerCase());
    },
  };
}

/**
 * In-memory keystore for tests and ephemeral runs. Nothing is persisted, so a
 * process restart loses every session — which is the correct behaviour for a
 * test fixture and the wrong behaviour for a product.
 */
export function memoryKeystore(): SessionKeystore {
  const wallets = new Map<string, Wallet>();
  const meta = new Map<string, StoredSessionKey>();
  return {
    async create(label) {
      const w = new Wallet(hexlifyBytes(randomBytes(32)));
      wallets.set(w.address.toLowerCase(), w);
      meta.set(w.address.toLowerCase(), {
        address: w.address,
        label,
        createdAt: new Date().toISOString(),
        file: "(memory)",
      });
      return w.address;
    },
    async load(address) {
      const w = wallets.get(address.toLowerCase());
      if (w === undefined) throw new KeystoreError(`no in-memory key for ${address}`);
      return w;
    },
    async list() {
      return [...meta.values()];
    },
    async destroy(address) {
      wallets.delete(address.toLowerCase());
      meta.delete(address.toLowerCase());
    },
  };
}

function hexlifyBytes(b: Uint8Array): string {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** @internal Re-exported so the MCP layer can reuse the same wallet type. */
export type { HDNodeWallet };
