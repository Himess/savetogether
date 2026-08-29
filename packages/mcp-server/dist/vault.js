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
exports.Vault = exports.SEPOLIA_CHAIN_ID = void 0;
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
const node_readline_1 = require("node:readline");
const sdk_1 = require("@ghostkey/sdk");
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/** Only Sepolia. Asserted, not assumed — see {@link Vault.unlock}. */
exports.SEPOLIA_CHAIN_ID = 11155111;
class Vault {
    opts;
    store;
    cached = null;
    constructor(opts) {
        this.opts = opts;
        this.store = (0, sdk_1.osKeychainKeystore)({
            dir: opts.dir ?? path.join(os.homedir(), ".ghostkey", "vault"),
            service: "ghostkey-vault",
        });
    }
    /** Creates the vault key if there is not one already. Returns its address. */
    async ensure() {
        const existing = await this.store.list();
        const first = existing[0];
        if (first !== undefined)
            return first.address;
        return this.store.create("ghostkey-vault");
    }
    async address() {
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
    async unlock(reason) {
        if (this.cached !== null)
            return this.cached;
        const address = await this.address();
        if (address === null)
            throw new Error("no vault key: run `ghostkey init` first");
        if (this.opts.devUnlock === true) {
            // A recording convenience must never be able to authorise real value. The
            // gate is on the chain id, checked here rather than at construction, so a
            // provider swapped after startup cannot slip past it.
            if (this.opts.chainId !== exports.SEPOLIA_CHAIN_ID) {
                throw new Error(`--dev-unlock is restricted to Sepolia (chainId ${exports.SEPOLIA_CHAIN_ID}); this process is on chainId ${this.opts.chainId}`);
            }
        }
        else if (this.opts.console !== undefined) {
            const answer = await this.opts.console.ask("unlock", reason);
            if (!answer.approved)
                throw new Error("the vault unlock was declined at the console");
        }
        else {
            const ok = await confirmAtTerminal(reason);
            if (!ok)
                throw new Error("the vault unlock was declined at the terminal");
        }
        const wallet = (await this.store.load(address)).connect(this.opts.provider);
        this.cached = wallet;
        return wallet;
    }
    /** Drops the decrypted key. Called immediately after the session open. */
    lock() {
        this.cached = null;
    }
    get isUnlocked() {
        return this.cached !== null;
    }
}
exports.Vault = Vault;
/**
 * Terminal fallback. Reads from the controlling TTY rather than stdin, because
 * stdin is the MCP transport — a conversation must not be able to answer this.
 */
async function confirmAtTerminal(reason) {
    if (!process.stderr.isTTY)
        return false;
    const rl = (0, node_readline_1.createInterface)({ input: process.stdin, output: process.stderr });
    try {
        const answer = await new Promise((resolve) => rl.question(`\nGhostKey — unlock the vault?\n  ${reason}\n  [y/N] `, resolve));
        return answer.trim().toLowerCase() === "y";
    }
    finally {
        rl.close();
    }
}
//# sourceMappingURL=vault.js.map