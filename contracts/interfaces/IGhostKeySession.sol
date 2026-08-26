// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title  IGhostKeySession
 * @author GhostKey
 * @notice Encrypted spending budgets for ERC-7984 confidential tokens.
 *
 * @dev TERMINOLOGY. Two principals are deliberately kept distinct throughout this
 *      codebase, and the word "agent" is never used on its own because it conflates them:
 *
 *      - `session client` — the process that holds the session key, constructs the
 *        encrypted inputs, and submits transactions. It knows the plaintext amount,
 *        because it is the party that chose it.
 *      - `model` — the language model driving the session client. It sees only what the
 *        user typed and opaque handle references. It never holds the session key and
 *        never sees a plaintext amount unless a decrypted value is handed back to it.
 *
 *      The security model may treat the two as one principal. The privacy claim depends
 *      on separating them.
 */
interface IGhostKeySession {
    /**
     * @notice Plaintext parameters of a session. Deliberately public and auditable.
     * @dev Packs into a single storage slot. Sentinels, rather than extra flags, encode
     *      lifecycle: `owner == address(0)` means the key has never been used;
     *      `expiry == 0` means the session was closed; `expiry <= block.timestamp` means
     *      it lapsed. `owner` is never cleared, which is what makes a session key
     *      single-use for all time.
     * @param owner      The account whose tokens the session may move. Never cleared.
     * @param expiry     UNIX seconds after which the session is dead. 0 means closed.
     * @param maxTxCount Maximum number of sends. 0 means unlimited.
     * @param txCount    Sends performed so far.
     */
    struct Session {
        address owner;
        uint48 expiry;
        uint24 maxTxCount;
        uint24 txCount;
    }

    /**
     * @notice Everything needed to open a session in one transaction.
     * @dev `tokens` and `budgets` are parallel arrays sharing ONE input proof, so a
     *      multi-token session costs a single signature. `recipients` may not be empty:
     *      an empty allowlist means no transfers, never "any recipient".
     * @param sessionKey  The session key. Also the session identifier. Single-use for all time.
     * @param expiry      UNIX seconds. Must be in the future.
     * @param maxTxCount  Maximum sends, or 0 for unlimited.
     * @param tokens      ERC-7984 tokens this session may spend. No duplicates.
     * @param budgets     Encrypted budget per token, same order and length as `tokens`.
     * @param recipients  Plaintext recipient allowlist. Public by design — see {send}.
     */
    struct SessionParams {
        address sessionKey;
        uint48 expiry;
        uint24 maxTxCount;
        address[] tokens;
        externalEuint64[] budgets;
        address[] recipients;
    }

    /// @notice A session was opened.
    /// @param owner      The account whose tokens the session may move.
    /// @param sessionKey The session key and identifier.
    /// @param expiry     UNIX seconds after which the session is dead.
    /// @param maxTxCount Maximum sends, or 0 for unlimited.
    /// @param tokens     Tokens funded at open.
    /// @param recipients The recipient allowlist.
    event SessionOpened(
        address indexed owner,
        address indexed sessionKey,
        uint48 expiry,
        uint24 maxTxCount,
        address[] tokens,
        address[] recipients
    );

    /**
     * @notice A send was attempted. Emitted identically whether or not value moved.
     * @dev The two encrypted fields are what let a client tell the failure modes apart
     *      without leaking anything to an observer:
     *      - `within` false                 -> the budget was exceeded
     *      - `within` true and `sent` zero  -> the holder's balance was insufficient
     *      A zero `requested` also produces `within` true with `sent` zero. The session
     *      client constructed the ciphertext and therefore knows its own plaintext, so it
     *      must reject a zero amount before submitting rather than misreport it here.
     * @param sessionKey The session key that sent.
     * @param token      The ERC-7984 token.
     * @param to         The recipient. Plaintext: ERC-7984 transfer graphs are public.
     * @param within     Encrypted: was the request within budget.
     * @param sent       Encrypted: how much actually moved. Zero or the full amount, never partial.
     */
    event Sent(
        address indexed sessionKey,
        address indexed token,
        address indexed to,
        ebool within,
        euint64 sent
    );

    /// @notice A recipient was added to a live session.
    /// @param sessionKey The session key.
    /// @param to The newly allowed recipient.
    event RecipientAdded(address indexed sessionKey, address indexed to);

    /// @notice A recipient was removed from a live session.
    /// @param sessionKey The session key.
    /// @param to The removed recipient.
    /// @param by The owner or the session key.
    event RecipientRemoved(address indexed sessionKey, address indexed to, address indexed by);

    /// @notice A token budget was topped up by the owner.
    /// @param sessionKey The session key.
    /// @param token      The token whose budget grew.
    event BudgetIncreased(address indexed sessionKey, address indexed token);

    /// @notice A session was closed and can never be reopened.
    /// @param sessionKey The session key.
    /// @param closedBy   The owner or the session key itself.
    event SessionClosed(address indexed sessionKey, address indexed closedBy);

    /// @notice The session key has already been used by some session, live or closed.
    /// @param sessionKey The offending key.
    error SessionKeyAlreadyUsed(address sessionKey);
    /// @notice No session has ever existed for this key.
    /// @param sessionKey The offending key.
    error NoSuchSession(address sessionKey);
    /// @notice The session was closed.
    /// @param sessionKey The offending key.
    error SessionIsClosed(address sessionKey);
    /// @notice The session's expiry has passed.
    /// @param sessionKey The offending key.
    error SessionExpired(address sessionKey);
    /// @notice The session has performed its maximum number of sends.
    /// @param sessionKey The offending key.
    error TxCountExhausted(address sessionKey);
    /// @notice The recipient is not on the session's allowlist.
    /// @param sessionKey The session key.
    /// @param to         The rejected recipient.
    error RecipientNotAllowed(address sessionKey, address to);
    /// @notice The token was not funded at openSession, so the session may not even call it.
    /// @param sessionKey The session key.
    /// @param token      The rejected token.
    error TokenNotInSession(address sessionKey, address token);
    /// @notice The caller does not own this session.
    /// @param sessionKey The session key.
    error NotSessionOwner(address sessionKey);
    /// @notice The caller is neither the session owner nor the session key.
    /// @param sessionKey The session key.
    error NotOwnerOrSessionKey(address sessionKey);
    /// @notice `tokens` and `budgets` differ in length.
    error ArrayLengthMismatch();
    /// @notice A session must fund at least one token and allow at least one recipient.
    error EmptySessionScope();
    /// @notice The expiry is not in the future.
    error InvalidExpiry();
    /// @notice A required address argument was zero.
    error ZeroAddress();
    /// @notice The same token appeared twice in `tokens`.
    /// @param token The duplicated token.
    error DuplicateToken(address token);
    /// @notice The session key did not sign its consent to be opened by this owner.
    error InvalidSessionKeySignature();
    /// @notice More tokens than {GhostKeySession-MAX_TOKENS}.
    /// @param count The rejected count.
    error TooManyTokens(uint256 count);
    /// @notice More recipients than {GhostKeySession-MAX_RECIPIENTS}.
    /// @param count The rejected count.
    error TooManyRecipients(uint256 count);
    /// @notice The recipient is already on the allowlist.
    /// @param to The recipient.
    error RecipientAlreadyAllowed(address to);
    /// @notice The recipient is not on the allowlist, so it cannot be removed.
    /// @param to The recipient.
    error RecipientNotInSession(address to);

    /// @notice Opens a session. Caller becomes the owner.
    /// @dev The session key must consent by signature, which is what stops anyone from
    ///      front-running the call with the same key and permanently burning it.
    /// @param params The session parameters.
    /// @param inputProof One proof covering every entry of `params.budgets`.
    /// @param sessionKeySignature EIP-712 signature by `params.sessionKey` over the digest
    ///        from {openSessionDigest}, binding the key to this owner.
    function openSession(
        SessionParams calldata params,
        bytes calldata inputProof,
        bytes calldata sessionKeySignature
    ) external;

    /// @notice The EIP-712 digest a session key must sign to be opened by `owner`.
    /// @dev `chainId` and `verifyingContract` are bound through the EIP-712 domain
    ///      separator rather than the struct, so a signature is useless on another chain
    ///      or another deployment. No nonce is needed: a key is single-use.
    /// @param owner The account that will open the session.
    /// @param sessionKey The session key granting consent.
    /// @param expiry The session expiry being consented to.
    /// @param maxTxCount The send cap being consented to.
    /// @return The digest to sign.
    function openSessionDigest(
        address owner,
        address sessionKey,
        uint48 expiry,
        uint24 maxTxCount
    ) external view returns (bytes32);

    /// @notice Adds a recipient to a live session's allowlist. Owner only.
    /// @param sessionKey The session key.
    /// @param to The recipient to allow.
    function addRecipient(address sessionKey, address to) external;

    /// @notice Removes a recipient. Callable by the owner or by the session key.
    /// @param sessionKey The session key.
    /// @param to The recipient to remove.
    function removeRecipient(address sessionKey, address to) external;

    /// @notice Spends from the session budget. Never reverts on a budget or balance failure.
    /// @param token The ERC-7984 token to spend.
    /// @param to The recipient, which must be on the allowlist.
    /// @param encAmount The encrypted amount, bound to this contract and to the caller.
    /// @param inputProof The proof for `encAmount`.
    function send(
        address token,
        address to,
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external;

    /// @notice Tops up one token budget. Owner only.
    /// @param sessionKey The session key.
    /// @param token The token whose budget grows.
    /// @param encAmount The encrypted amount to add.
    /// @param inputProof The proof for `encAmount`.
    function increaseBudget(
        address sessionKey,
        address token,
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external;

    /// @notice Closes a session permanently. Callable by the owner or by the session key.
    /// @param sessionKey The session key.
    function closeSession(address sessionKey) external;

    /// @notice Reads the plaintext session parameters.
    /// @param sessionKey The session key.
    /// @return The session struct.
    function sessionOf(address sessionKey) external view returns (Session memory);

    /// @notice Reads the encrypted remaining budget handle.
    /// @param sessionKey The session key.
    /// @param token The token.
    /// @return The handle. Zero when the token was never funded for this session.
    function remainingOf(address sessionKey, address token) external view returns (euint64);

    /// @notice Whether a recipient is on the session's allowlist.
    /// @param sessionKey The session key.
    /// @param to The recipient.
    /// @return Whether transfers to `to` are permitted.
    function isRecipientAllowed(address sessionKey, address to) external view returns (bool);

    /// @notice The full recipient allowlist.
    /// @param sessionKey The session key.
    /// @return The allowed recipients.
    function recipientsOf(address sessionKey) external view returns (address[] memory);

    /// @notice The tokens funded for a session.
    /// @param sessionKey The session key.
    /// @return The funded tokens.
    function tokensOf(address sessionKey) external view returns (address[] memory);

    /**
     * @notice Protocol conditions that make {send} revert for reasons outside this contract.
     * @dev {send} never reverts on a budget or balance failure. It can still revert because
     *      the FHEVM ACL is paused or has deny-listed a participant, since `ACL.allow` is
     *      `whenNotPaused` and rejects a denied caller. This view exists so a client can
     *      report the real cause instead of an opaque failure.
     * @param sessionKey The session key to check.
     * @return aclPaused Whether the ACL is paused.
     * @return keyDenied Whether the session key is deny-listed.
     * @return moduleDenied Whether this module is deny-listed.
     */
    function protocolStatus(
        address sessionKey
    ) external view returns (bool aclPaused, bool keyDenied, bool moduleDenied);
}
