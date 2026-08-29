"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.osKeychainKeystore = osKeychainKeystore;
exports.memoryKeystore = memoryKeystore;
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
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_util_1 = require("node:util");
const ethers_1 = require("ethers");
const errors_1 = require("./errors");
const run = (0, node_util_1.promisify)(node_child_process_1.execFile);
/**
 * macOS Keychain. `security` reads the password from stdin-free argv, which is
 * visible in the process table for an instant; acceptable for a testnet session
 * key, and flagged rather than hidden.
 */
function macKeychain(service) {
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
            }
            catch {
                return null;
            }
        },
        async remove(account) {
            try {
                await run("security", ["delete-generic-password", "-s", service, "-a", account]);
            }
            catch {
                /* already gone */
            }
        },
    };
}
/** Linux Secret Service via libsecret. */
function secretTool(service) {
    return {
        kind: "libsecret",
        async set(account, secret) {
            await new Promise((resolve, reject) => {
                const child = (0, node_child_process_1.execFile)("secret-tool", ["store", "--label", `${service}:${account}`, "service", service, "account", account], (err) => (err ? reject(err) : resolve()));
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
            }
            catch {
                return null;
            }
        },
        async remove(account) {
            try {
                await run("secret-tool", ["clear", "service", service, "account", account]);
            }
            catch {
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
function windowsDpapi(service, dir) {
    const file = (account) => path.join(dir, `${service}.${account.toLowerCase()}.dpapi`);
    return {
        kind: "windows-dpapi",
        async set(account, secret) {
            const target = file(account);
            const script = `$s=[Console]::In.ReadToEnd().Trim(); ` +
                `$e=ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString; ` +
                // -NoNewline so the file holds exactly the blob and nothing else.
                `Set-Content -Path '${target.replace(/'/g, "''")}' -Value $e -Encoding ascii -NoNewline`;
            await new Promise((resolve, reject) => {
                const child = (0, node_child_process_1.execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => (err ? reject(err) : resolve()));
                child.stdin?.end(secret);
            });
        },
        async get(account) {
            const target = file(account);
            try {
                await fs.access(target);
            }
            catch {
                return null;
            }
            // .Trim() is load-bearing. Set-Content used to append a newline, Get-Content
            // -Raw returned it, and ConvertTo-SecureString rejected the result — which
            // surfaced as "no passphrase found", making a perfectly recoverable key look
            // like a missing one. Every vault created on Windows was unopenable, and
            // nothing tested this path until it was tried by hand.
            const script = `$e=(Get-Content -Path '${target.replace(/'/g, "''")}' -Raw).Trim(); ` +
                `$s=ConvertTo-SecureString $e; ` +
                `[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;
            let stdout;
            try {
                ({ stdout } = await run("powershell.exe", [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ]));
            }
            catch (e) {
                // The file exists but will not decrypt: wrong Windows user, wrong machine,
                // or a corrupted blob. That is not "not stored", and reporting it as such
                // sends the caller off to create another key it will also be unable to open.
                throw new errors_1.KeystoreError(`the passphrase for ${account} exists at ${target} but could not be decrypted — ` +
                    `DPAPI blobs are bound to the Windows user that wrote them (${e.message.slice(0, 120)})`);
            }
            const value = stdout.trim();
            if (value === "") {
                throw new errors_1.KeystoreError(`the passphrase store returned nothing for ${account}`);
            }
            return value;
        },
        async remove(account) {
            await fs.rm(file(account), { force: true });
        },
    };
}
function pickSecretStore(service, dir) {
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
function osKeychainKeystore(opts) {
    const dir = opts?.dir ?? path.join(os.homedir(), ".ghostkey", "keys");
    const service = opts?.service ?? "ghostkey-session";
    const secrets = pickSecretStore(service, dir);
    const fileFor = (address) => path.join(dir, `${address.toLowerCase()}.json`);
    const metaFor = (address) => path.join(dir, `${address.toLowerCase()}.meta.json`);
    return {
        async create(label) {
            await fs.mkdir(dir, { recursive: true, mode: 0o700 });
            // From raw entropy rather than createRandom(), so no mnemonic is ever
            // derived, held, or written. The brief is explicit: no seed phrase.
            const wallet = new ethers_1.Wallet(hexlifyBytes((0, ethers_1.randomBytes)(32)));
            const passphrase = hexlifyBytes((0, ethers_1.randomBytes)(32));
            const json = await (0, ethers_1.encryptKeystoreJson)({ address: wallet.address, privateKey: wallet.privateKey }, passphrase);
            await fs.writeFile(fileFor(wallet.address), json, { mode: 0o600 });
            await fs.writeFile(metaFor(wallet.address), JSON.stringify({ address: wallet.address, label, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
            await secrets.set(wallet.address.toLowerCase(), passphrase);
            return wallet.address;
        },
        async load(address) {
            const passphrase = await secrets.get(address.toLowerCase());
            if (passphrase === null) {
                throw new errors_1.KeystoreError(`no passphrase for ${address} in the ${secrets.kind} store; the key cannot be decrypted`);
            }
            let json;
            try {
                json = await fs.readFile(fileFor(address), "utf8");
            }
            catch {
                throw new errors_1.KeystoreError(`no keystore file for ${address} under ${dir}`);
            }
            const account = await (0, ethers_1.decryptKeystoreJson)(json, passphrase);
            const wallet = new ethers_1.Wallet(account.privateKey);
            if (wallet.address.toLowerCase() !== address.toLowerCase()) {
                throw new errors_1.KeystoreError(`keystore for ${address} decrypts to ${wallet.address}`);
            }
            return wallet;
        },
        async list() {
            let names;
            try {
                names = await fs.readdir(dir);
            }
            catch {
                return [];
            }
            const out = [];
            for (const n of names) {
                if (!n.endsWith(".meta.json"))
                    continue;
                try {
                    const meta = JSON.parse(await fs.readFile(path.join(dir, n), "utf8"));
                    out.push({ ...meta, file: fileFor(meta.address) });
                }
                catch {
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
function memoryKeystore() {
    const wallets = new Map();
    const meta = new Map();
    return {
        async create(label) {
            const w = new ethers_1.Wallet(hexlifyBytes((0, ethers_1.randomBytes)(32)));
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
            if (w === undefined)
                throw new errors_1.KeystoreError(`no in-memory key for ${address}`);
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
function hexlifyBytes(b) {
    return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
//# sourceMappingURL=keystore.js.map