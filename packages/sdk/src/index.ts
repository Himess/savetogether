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
export { DEFAULT_SESSION_GAS, GhostKeyClient } from "./client";
export type {
  GhostKeyClientConfig,
  OpenSessionRequest,
  OpenSessionResult,
  ReadScope,
} from "./client";

export { AmountExpr, AmountRef, all, exact, ref, revealAmount } from "./amounts";
export type { AmountSource } from "./amounts";

export { BalanceVisibleSession, SpendOnlySession } from "./session";
export type {
  PreparedSend,
  Readiness,
  SendIntent,
  SendResult,
  Session,
  SessionParams,
} from "./session";

export { memoryKeystore, osKeychainKeystore } from "./keystore";
export type { SessionKeystore, StoredSessionKey } from "./keystore";

export {
  BalanceNotVisibleError,
  GhostKeyError,
  KeystoreError,
  OperatorNotGrantedError,
  ProtocolUnavailableError,
  RecipientNotAllowedError,
  SessionNotLiveError,
  ZeroAmountError,
} from "./errors";

export { ACL_ABI, ERC7984_ABI, GHOSTKEY_ABI } from "./abi";
