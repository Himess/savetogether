"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = exports.isTransient = exports.GHOSTKEY_ABI = exports.ERC7984_ABI = exports.ACL_ABI = exports.ZeroAmountError = exports.SessionNotLiveError = exports.RecipientNotAllowedError = exports.ProtocolUnavailableError = exports.OperatorNotGrantedError = exports.KeystoreError = exports.GhostKeyError = exports.BalanceNotVisibleError = exports.osKeychainKeystore = exports.memoryKeystore = exports.SpendOnlySession = exports.BalanceVisibleSession = exports.revealAmount = exports.ref = exports.exact = exports.all = exports.AmountRef = exports.AmountExpr = exports.GhostKeyClient = exports.DEFAULT_SESSION_GAS = void 0;
/**
 * GhostKey SDK — headless client for encrypted spending sessions on ERC-7984.
 *
 * Usable with no MCP server and no language model. Nothing in this package
 * imports from `@ghostkey/mcp-server` or assumes a chat context; that separation
 * is what makes GhostKey infrastructure rather than a demo.
 *
 * TERMINOLOGY. Two principals, kept distinct throughout: the `session client` is
 * the process that holds the keys, builds ciphertexts and submits transactions —
 * it necessarily knows plaintext amounts, because it chose them. The `model` is
 * the language model driving it, and sees only what the user typed and opaque
 * references. The word "agent" is never used alone, because it conflates them and
 * the privacy claim depends on the distinction.
 */
var client_1 = require("./client");
Object.defineProperty(exports, "DEFAULT_SESSION_GAS", { enumerable: true, get: function () { return client_1.DEFAULT_SESSION_GAS; } });
Object.defineProperty(exports, "GhostKeyClient", { enumerable: true, get: function () { return client_1.GhostKeyClient; } });
var amounts_1 = require("./amounts");
Object.defineProperty(exports, "AmountExpr", { enumerable: true, get: function () { return amounts_1.AmountExpr; } });
Object.defineProperty(exports, "AmountRef", { enumerable: true, get: function () { return amounts_1.AmountRef; } });
Object.defineProperty(exports, "all", { enumerable: true, get: function () { return amounts_1.all; } });
Object.defineProperty(exports, "exact", { enumerable: true, get: function () { return amounts_1.exact; } });
Object.defineProperty(exports, "ref", { enumerable: true, get: function () { return amounts_1.ref; } });
Object.defineProperty(exports, "revealAmount", { enumerable: true, get: function () { return amounts_1.revealAmount; } });
var session_1 = require("./session");
Object.defineProperty(exports, "BalanceVisibleSession", { enumerable: true, get: function () { return session_1.BalanceVisibleSession; } });
Object.defineProperty(exports, "SpendOnlySession", { enumerable: true, get: function () { return session_1.SpendOnlySession; } });
var keystore_1 = require("./keystore");
Object.defineProperty(exports, "memoryKeystore", { enumerable: true, get: function () { return keystore_1.memoryKeystore; } });
Object.defineProperty(exports, "osKeychainKeystore", { enumerable: true, get: function () { return keystore_1.osKeychainKeystore; } });
var errors_1 = require("./errors");
Object.defineProperty(exports, "BalanceNotVisibleError", { enumerable: true, get: function () { return errors_1.BalanceNotVisibleError; } });
Object.defineProperty(exports, "GhostKeyError", { enumerable: true, get: function () { return errors_1.GhostKeyError; } });
Object.defineProperty(exports, "KeystoreError", { enumerable: true, get: function () { return errors_1.KeystoreError; } });
Object.defineProperty(exports, "OperatorNotGrantedError", { enumerable: true, get: function () { return errors_1.OperatorNotGrantedError; } });
Object.defineProperty(exports, "ProtocolUnavailableError", { enumerable: true, get: function () { return errors_1.ProtocolUnavailableError; } });
Object.defineProperty(exports, "RecipientNotAllowedError", { enumerable: true, get: function () { return errors_1.RecipientNotAllowedError; } });
Object.defineProperty(exports, "SessionNotLiveError", { enumerable: true, get: function () { return errors_1.SessionNotLiveError; } });
Object.defineProperty(exports, "ZeroAmountError", { enumerable: true, get: function () { return errors_1.ZeroAmountError; } });
var abi_1 = require("./abi");
Object.defineProperty(exports, "ACL_ABI", { enumerable: true, get: function () { return abi_1.ACL_ABI; } });
Object.defineProperty(exports, "ERC7984_ABI", { enumerable: true, get: function () { return abi_1.ERC7984_ABI; } });
Object.defineProperty(exports, "GHOSTKEY_ABI", { enumerable: true, get: function () { return abi_1.GHOSTKEY_ABI; } });
var fhe_1 = require("./fhe");
Object.defineProperty(exports, "isTransient", { enumerable: true, get: function () { return fhe_1.isTransient; } });
Object.defineProperty(exports, "withRetry", { enumerable: true, get: function () { return fhe_1.withRetry; } });
//# sourceMappingURL=index.js.map