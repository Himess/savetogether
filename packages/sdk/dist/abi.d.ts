/**
 * Human-readable ABI fragments. Kept here rather than imported from the Hardhat
 * artifacts so the SDK builds and publishes without the contracts workspace.
 *
 * These must stay in step with `contracts/interfaces/IGhostKeySession.sol`. The
 * integration tests call every one of them against a live deployment, which is
 * what catches drift.
 */
export declare const GHOSTKEY_ABI: readonly ["function openSession((address sessionKey,uint48 expiry,uint24 maxTxCount,address[] tokens,bytes32[] budgets,address[] recipients) params, bytes inputProof, bytes sessionKeySignature)", "function send(address token, address to, bytes32 encAmount, bytes inputProof)", "function increaseBudget(address sessionKey, address token, bytes32 encAmount, bytes inputProof)", "function addRecipient(address sessionKey, address to)", "function removeRecipient(address sessionKey, address to)", "function closeSession(address sessionKey)", "function openSessionDigest(address owner, address sessionKey, uint48 expiry, uint24 maxTxCount) view returns (bytes32)", "function sessionOf(address sessionKey) view returns ((address owner,uint48 expiry,uint24 maxTxCount,uint24 txCount))", "function remainingOf(address sessionKey, address token) view returns (bytes32)", "function isRecipientAllowed(address sessionKey, address to) view returns (bool)", "function recipientsOf(address sessionKey) view returns (address[])", "function tokensOf(address sessionKey) view returns (address[])", "function protocolStatus(address sessionKey) view returns (bool aclPaused, bool keyDenied, bool moduleDenied)", "function MAX_TOKENS() view returns (uint256)", "function MAX_RECIPIENTS() view returns (uint256)", "event Sent(address indexed sessionKey, address indexed token, address indexed to, bytes32 within, bytes32 sent)", "event SessionOpened(address indexed owner, address indexed sessionKey, uint48 expiry, uint24 maxTxCount, address[] tokens, address[] recipients)", "event SessionClosed(address indexed sessionKey, address indexed closedBy)", "event RecipientAdded(address indexed sessionKey, address indexed to)", "event RecipientRemoved(address indexed sessionKey, address indexed to, address indexed by)"];
export declare const ERC7984_ABI: readonly ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function confidentialBalanceOf(address account) view returns (bytes32)", "function isOperator(address holder, address spender) view returns (bool)", "function setOperator(address operator, uint48 until)"];
/**
 * Singular only. The array form of `delegateForUserDecryption` does not exist on
 * the deployed ACL — step 1 checked the bytecode. Several tokens are delegated in
 * one transaction through `multicall`, not through a batch entrypoint.
 */
export declare const ACL_ABI: readonly ["function delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate)", "function revokeDelegationForUserDecryption(address delegate, address contractAddress)", "function getUserDecryptionDelegationExpirationDate(address delegator, address delegate, address contractAddress) view returns (uint64)", "function multicall(bytes[] data) payable returns (bytes[] results)"];
/** The EIP-712 domain and type the session key signs to consent to being opened. */
export declare const OPEN_SESSION_TYPES: {
    readonly OpenSession: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly name: "sessionKey";
        readonly type: "address";
    }, {
        readonly name: "expiry";
        readonly type: "uint48";
    }, {
        readonly name: "maxTxCount";
        readonly type: "uint24";
    }];
};
export declare const EIP712_DOMAIN_NAME = "GhostKeySession";
export declare const EIP712_DOMAIN_VERSION = "1";
