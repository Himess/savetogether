// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig, ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IACL} from "@fhevm/solidity/lib/Impl.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISaveTogetherSession} from "./interfaces/ISaveTogetherSession.sol";

/// @title  IACLPausable
/// @author SaveTogether
/// @notice The deployed ACL is pausable but `IACL` does not declare it. Selector 0x5c975abb
///         is present in the Sepolia implementation at 0xf4f793e6a2ef47de60a94c0bc412292da5f7ab98.
interface IACLPausable {
    /// @notice Whether the ACL is paused.
    /// @return Whether all ACL mutations currently revert.
    function paused() external view returns (bool);
}

/**
 * @title  SaveTogetherSession
 * @author SaveTogether
 * @notice Gives an ERC-7984 operator an ENCRYPTED spending budget.
 *
 * @dev THE PROBLEM. `ERC7984.setOperator(spender, until)` grants unlimited spending
 *      authority bounded only by time. OpenZeppelin's own documentation warns that
 *      setting an operator lets that address take all of your tokens.
 *
 *      THE MECHANISM. This module holds an `euint64 remaining` per (session key, token)
 *      and clamps every transfer against it homomorphically. A request over budget is
 *      not rejected — it is silently reduced to an encrypted zero and still executed.
 *      There is no revert, no plaintext comparison and no branch on an encrypted value,
 *      so an observer cannot tell an accepted transfer from a rejected one.
 *
 *      THREE AUTHORITIES, KEPT SEPARATE.
 *      - move   `token.setOperator(thisModule, expiry)` — the module can move, not read
 *      - read   `ACL.delegateForUserDecryption(sessionKey, token, expiry)` — optional,
 *               and needed for exactly one thing: reading the holder's BALANCE, which is
 *               only required for reference amounts such as "send half". A session works
 *               without it; the session client can still read what it spent and what is
 *               left, because those are this module's own handles.
 *      - amount `remaining`, inside this contract, visible to nobody
 *
 *      WHAT LEAKS. Recipients, token addresses, session lifetimes, and the number of
 *      sends are all public. ERC-7984 transfer graphs are public by construction, so the
 *      allowlist is plaintext: encrypting it would be theatre. Only amounts are hidden.
 *
 *      TERMINOLOGY. `session client` and `model` are distinguished throughout. See
 *      {ISaveTogetherSession}. The word "agent" is never used alone.
 */
contract SaveTogetherSession is ISaveTogetherSession, ZamaEthereumConfig, EIP712, ReentrancyGuard {
    /// @notice Maximum tokens fundable in one session.
    /// @dev Bounds {tokensOf}, which returns the whole array, so an oversized session
    ///      cannot make its own views uncallable. Well above any realistic session:
    ///      a wallet holding 32 distinct confidential tokens is not the target user.
    uint256 public constant MAX_TOKENS = 32;

    /// @notice Maximum recipients on a session allowlist.
    /// @dev Same reasoning as {MAX_TOKENS}, bounding {recipientsOf}. Enforced in
    ///      {addRecipient} as well as {openSession}, so the cap cannot be walked past.
    uint256 public constant MAX_RECIPIENTS = 128;

    /// @dev EIP-712 type hash for the session key's consent to be opened by an owner.
    ///      `chainId` and `verifyingContract` are NOT struct fields: they live in the
    ///      EIP-712 domain separator, which is the standard place for them and is what
    ///      makes a signature unusable on another chain or another deployment.
    bytes32 private constant _OPEN_TYPEHASH = keccak256(
        "OpenSession(address owner,address sessionKey,uint48 expiry,uint24 maxTxCount)"
    );

    mapping(address sessionKey => Session session) private _sessions;
    mapping(address sessionKey => mapping(address token => euint64 remaining)) private _remaining;
    /// @dev One-based index into {_recipients}. Zero means "not on the allowlist", which
    ///      doubles as the membership test, so no separate bool mapping is needed.
    mapping(address sessionKey => mapping(address to => uint256 indexPlusOne))
        private _recipientIndex;
    mapping(address sessionKey => address[] recipients) private _recipients;
    mapping(address sessionKey => address[] tokens) private _tokens;

    /// @notice Deploys the module.
    /**
     * The EIP-712 domain name is "GhostKeySession" and MUST NOT be changed.
     *
     * It is not a label. It is hashed into the domain separator, so every
     * signature the SDK produces is verified against it — and the module already
     * deployed at 0xE5c667c0…36Cf6 has this exact string in its bytecode. The
     * project was renamed from GhostKey to SaveTogether after that deployment;
     * renaming this too would make every `openSession` revert with
     * `InvalidSessionKeySignature`, which is precisely what a blind rename did
     * and what catching it before shipping was worth.
     *
     * Change it only alongside a redeployment of this module, and only with the
     * SDK's `EIP712_DOMAIN_NAME` changed in the same commit.
     */
    constructor() EIP712("GhostKeySession", "1") {}

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev FRONT-RUNNING. The session key travels in mempool calldata. Without proof of
     *      the key's consent, anyone could watch a pending `openSession`, resubmit the
     *      same key with more gas, take ownership, and make the honest call revert with
     *      {SessionKeyAlreadyUsed} — permanently burning that key, since the single-use
     *      invariant never clears `owner`. No funds would be at risk, but every session
     *      open would be grievable for the price of gas.
     *
     *      The `sessionKeySignature` closes it. The session client generates the key
     *      locally, so signing costs nothing, and the signature binds the key to ONE
     *      owner. An attacker cannot reuse a captured signature, because the signed
     *      `owner` is checked against `msg.sender`; and cannot forge their own, because
     *      that needs the session key's private key. One `ecrecover`.
     *
     *      No nonce is required: a key is single-use, so a replayed signature meets
     *      {SessionKeyAlreadyUsed} on the second attempt.
     */
    function openSession(
        SessionParams calldata params,
        bytes calldata inputProof,
        bytes calldata sessionKeySignature
    ) external override {
        if (params.sessionKey == address(0)) revert ZeroAddress();
        if (params.tokens.length != params.budgets.length) revert ArrayLengthMismatch();
        if (params.tokens.length == 0 || params.recipients.length == 0) revert EmptySessionScope();
        if (params.tokens.length > MAX_TOKENS) revert TooManyTokens(params.tokens.length);
        if (params.recipients.length > MAX_RECIPIENTS) {
            revert TooManyRecipients(params.recipients.length);
        }
        if (params.expiry <= block.timestamp) revert InvalidExpiry();

        // A session key is consumed permanently at first use, not merely while live.
        // ACL delegations granted to a key live in the ACL, not here, so letting a closed
        // key be reopened would silently carry a stale delegation into the new session.
        if (_sessions[params.sessionKey].owner != address(0)) {
            revert SessionKeyAlreadyUsed(params.sessionKey);
        }

        bytes32 digest = openSessionDigest(
            msg.sender,
            params.sessionKey,
            params.expiry,
            params.maxTxCount
        );
        if (ECDSA.recover(digest, sessionKeySignature) != params.sessionKey) {
            revert InvalidSessionKeySignature();
        }

        _sessions[params.sessionKey] = Session({
            owner: msg.sender,
            expiry: params.expiry,
            maxTxCount: params.maxTxCount,
            txCount: 0
        });

        for (uint256 i = 0; i < params.tokens.length; ++i) {
            address token = params.tokens[i];
            if (token == address(0)) revert ZeroAddress();
            if (FHE.isInitialized(_remaining[params.sessionKey][token])) {
                revert DuplicateToken(token);
            }

            // Every budget is verified against the SAME proof, which is what keeps a
            // multi-token session to one signature. `fromExternal` consumes no HCU, so
            // the practical ceiling here is calldata and EVM gas, not the FHE budget.
            euint64 budget = FHE.fromExternal(params.budgets[i], inputProof);
            _remaining[params.sessionKey][token] = budget;
            _tokens[params.sessionKey].push(token);

            FHE.allowThis(budget);
            FHE.allow(budget, msg.sender);
            FHE.allow(budget, params.sessionKey);
        }

        for (uint256 i = 0; i < params.recipients.length; ++i) {
            _addRecipient(params.sessionKey, params.recipients[i]);
        }

        emit SessionOpened(
            msg.sender,
            params.sessionKey,
            params.expiry,
            params.maxTxCount,
            params.tokens,
            params.recipients
        );
    }

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev THE CORE FUNCTION. Read the ordering carefully; it is forced, not chosen.
     *
     *      REENTRANCY. The budget write depends on `sent`, which does not exist until the
     *      token returns, so the state update is structurally forced to follow the external
     *      call. Checks-effects-interactions cannot be satisfied here: `txCount` is pushed
     *      ahead of the call, but the budget cannot be. `nonReentrant` is therefore
     *      load-bearing, not defensive styling.
     *
     *      WHY THE TOKEN GUARD EXISTS. An uninitialized budget already makes `within`
     *      false, which prevents SPENDING. It does not prevent CALLING. Without the
     *      `isInitialized` check below, a compromised session key could pass any address as
     *      `token` and this contract would both grant it transient ACL access and call it.
     *      The check costs no HCU — `isInitialized` is a zero-check on the handle — and
     *      restricts calls to tokens registered at {openSession}. A drained budget stays
     *      initialized, so legitimate flows are untouched.
     *
     *      WHY IT IS INDISTINGUISHABLE. Every path runs the identical operation sequence.
     *      An over-budget request still performs a real `confidentialTransferFrom`, with an
     *      encrypted zero. `FHE.select` and `FHE.add` mint a fresh handle on every path
     *      regardless of the encrypted condition, so `remaining` is always written with a
     *      changed value and the same-value SSTORE discount never applies anywhere. Same
     *      operations, same storage writes, same event topics, same gas.
     */
    function send(
        address token,
        address to,
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external override nonReentrant {
        Session storage s = _sessions[msg.sender];
        address owner_ = s.owner;

        if (owner_ == address(0)) revert NoSuchSession(msg.sender);
        if (s.expiry == 0) revert SessionIsClosed(msg.sender);
        if (s.expiry <= block.timestamp) revert SessionExpired(msg.sender);
        if (s.maxTxCount != 0 && s.txCount >= s.maxTxCount) revert TxCountExhausted(msg.sender);
        if (_recipientIndex[msg.sender][to] == 0) revert RecipientNotAllowed(msg.sender, to);

        euint64 budget = _remaining[msg.sender][token];
        if (!FHE.isInitialized(budget)) revert TokenNotInSession(msg.sender, token);

        // The only effect that can precede the interaction.
        ++s.txCount;

        // Clamp. `tryDecrease` returns the untouched old value when the request exceeds it,
        // so an over-budget request leaves `remaining` exactly where it was.
        euint64 requested = FHE.fromExternal(encAmount, inputProof);
        (ebool within, euint64 clamped) = FHESafeMath.tryDecrease(budget, requested);
        euint64 amount = FHE.select(within, requested, FHE.asEuint64(0));

        // The token computes on `amount` inside `_update`, so it needs its own access.
        // This module's access is automatic: the executor grants the computing contract
        // transient access to every handle it produces.
        FHE.allowTransient(amount, token);
        euint64 sent = IERC7984(token).confidentialTransferFrom(owner_, to, amount);

        // Reconcile in the SAME transaction. `sent` is granted to this module with
        // `allowTransient`, so its access dies when the transaction ends. Deferring this
        // to a later transaction is not a design option; it is impossible.
        //   over budget   -> amount 0,         sent 0 -> refund 0,         budget unchanged
        //   balance short -> amount requested, sent 0 -> refund requested, budget restored
        //   success       -> amount requested, sent = amount -> refund 0,  budget decremented
        euint64 refund = FHE.sub(amount, sent);
        euint64 newRemaining = FHE.add(clamped, refund);
        _remaining[msg.sender][token] = newRemaining;

        // Transient access is sufficient to issue a persistent grant: ACL.allow gates on
        // isAllowed, and isAllowed is `allowedTransient || persistAllowed`. This is what
        // makes the emitted handles decryptable after the transaction ends.
        //
        // allowThis is required as well as the per-account grants: userDecrypt authorises
        // against BOTH the requesting account and the contract the handle is read through,
        // and this module holds only transient access to `within` and `sent`.
        FHE.allowThis(newRemaining);
        FHE.allowThis(within);
        FHE.allowThis(sent);
        FHE.allow(newRemaining, owner_);
        FHE.allow(newRemaining, msg.sender);
        FHE.allow(within, owner_);
        FHE.allow(within, msg.sender);
        FHE.allow(sent, owner_);
        FHE.allow(sent, msg.sender);

        emit Sent(msg.sender, token, to, within, sent);
    }

    /// @inheritdoc ISaveTogetherSession
    function increaseBudget(
        address sessionKey,
        address token,
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external override {
        Session storage s = _sessions[sessionKey];
        if (s.owner == address(0)) revert NoSuchSession(sessionKey);
        if (s.owner != msg.sender) revert NotSessionOwner(sessionKey);
        if (s.expiry == 0) revert SessionIsClosed(sessionKey);
        // Topping up a lapsed session would leave the owner believing the session works.
        if (s.expiry <= block.timestamp) revert SessionExpired(sessionKey);

        euint64 current = _remaining[sessionKey][token];
        if (!FHE.isInitialized(current)) revert TokenNotInSession(sessionKey, token);

        // `tryAdd` reports failure by returning zero, which would erase the budget, so the
        // old value is reinstated explicitly on overflow rather than trusting its result.
        euint64 delta = FHE.fromExternal(encAmount, inputProof);
        (ebool ok, euint64 sum) = FHESafeMath.tryAdd(current, delta);
        euint64 updated = FHE.select(ok, sum, current);
        _remaining[sessionKey][token] = updated;

        FHE.allowThis(updated);
        FHE.allow(updated, msg.sender);
        FHE.allow(updated, sessionKey);

        emit BudgetIncreased(sessionKey, token);
    }

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev Owner only. This grants no authority the owner does not already hold — they
     *      could close the session and open a new one with a wider allowlist. What it
     *      avoids is burning the session key, re-delegating on the ACL and re-signing the
     *      budget batch every time a new recipient comes up mid-conversation, which is
     *      what "authorize once, talk all day" actually requires.
     */
    function addRecipient(address sessionKey, address to) external override {
        Session storage s = _sessions[sessionKey];
        if (s.owner == address(0)) revert NoSuchSession(sessionKey);
        if (s.owner != msg.sender) revert NotSessionOwner(sessionKey);
        if (s.expiry == 0) revert SessionIsClosed(sessionKey);
        if (s.expiry <= block.timestamp) revert SessionExpired(sessionKey);
        if (_recipientIndex[sessionKey][to] != 0) revert RecipientAlreadyAllowed(to);

        _addRecipient(sessionKey, to);
        emit RecipientAdded(sessionKey, to);
    }

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev Owner OR session key. The session client must be able to narrow its own scope
     *      defensively — on detecting something wrong it should not have to choose between
     *      carrying on and tearing the whole session down.
     */
    function removeRecipient(address sessionKey, address to) external override {
        Session storage s = _sessions[sessionKey];
        if (s.owner == address(0)) revert NoSuchSession(sessionKey);
        if (msg.sender != s.owner && msg.sender != sessionKey) {
            revert NotOwnerOrSessionKey(sessionKey);
        }

        uint256 idx = _recipientIndex[sessionKey][to];
        if (idx == 0) revert RecipientNotInSession(to);

        // Swap-and-pop, keeping the index map consistent for the element that moves.
        address[] storage list = _recipients[sessionKey];
        uint256 last = list.length;
        if (idx != last) {
            address moved = list[last - 1];
            list[idx - 1] = moved;
            _recipientIndex[sessionKey][moved] = idx;
        }
        list.pop();
        _recipientIndex[sessionKey][to] = 0;

        emit RecipientRemoved(sessionKey, to, msg.sender);
    }

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev Budgets are deliberately NOT zeroed. The plaintext guards in {send} already
     *      reject every call once `expiry` is 0, and a session key can never be reused, so
     *      a stale budget handle is unreachable. Zeroing would cost one FHE operation and
     *      one storage write per funded token, on a function that must stay cheap and
     *      unconditional — the session client has to be able to self-terminate even under
     *      gas pressure. Leaving the handle also keeps the final balance auditable by the
     *      owner after the fact.
     */
    function closeSession(address sessionKey) external override {
        Session storage s = _sessions[sessionKey];
        if (s.owner == address(0)) revert NoSuchSession(sessionKey);
        if (msg.sender != s.owner && msg.sender != sessionKey) {
            revert NotOwnerOrSessionKey(sessionKey);
        }
        if (s.expiry == 0) revert SessionIsClosed(sessionKey);

        s.expiry = 0;
        emit SessionClosed(sessionKey, msg.sender);
    }

    /// @inheritdoc ISaveTogetherSession
    function openSessionDigest(
        address owner,
        address sessionKey,
        uint48 expiry,
        uint24 maxTxCount
    ) public view override returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(_OPEN_TYPEHASH, owner, sessionKey, expiry, maxTxCount))
            );
    }

    /// @inheritdoc ISaveTogetherSession
    function sessionOf(address sessionKey) external view override returns (Session memory) {
        return _sessions[sessionKey];
    }

    /// @inheritdoc ISaveTogetherSession
    function remainingOf(
        address sessionKey,
        address token
    ) external view override returns (euint64) {
        return _remaining[sessionKey][token];
    }

    /// @inheritdoc ISaveTogetherSession
    function isRecipientAllowed(
        address sessionKey,
        address to
    ) external view override returns (bool) {
        return _recipientIndex[sessionKey][to] != 0;
    }

    /// @inheritdoc ISaveTogetherSession
    function recipientsOf(address sessionKey) external view override returns (address[] memory) {
        return _recipients[sessionKey];
    }

    /// @inheritdoc ISaveTogetherSession
    function tokensOf(address sessionKey) external view override returns (address[] memory) {
        return _tokens[sessionKey];
    }

    /**
     * @inheritdoc ISaveTogetherSession
     *
     * @dev The ACL address is resolved through `ZamaConfig.getEthereumCoprocessorConfig`,
     *      which despite its name dispatches on chainid across Ethereum mainnet, Sepolia
     *      and the local chain. It is the very function `ZamaEthereumConfig`'s constructor
     *      uses, so this view cannot disagree with the config the contract runs on.
     */
    function protocolStatus(
        address sessionKey
    ) external view override returns (bool aclPaused, bool keyDenied, bool moduleDenied) {
        address acl = ZamaConfig.getEthereumCoprocessorConfig().ACLAddress;
        aclPaused = IACLPausable(acl).paused();
        keyDenied = IACL(acl).isAccountDenied(sessionKey);
        moduleDenied = IACL(acl).isAccountDenied(address(this));
    }

    /// @notice Appends a recipient if absent.
    /// @dev Enforces {MAX_RECIPIENTS} on every path, so the cap cannot be walked past
    ///      by adding recipients one at a time after {openSession}.
    /// @param sessionKey The session key.
    /// @param to The recipient to allow.
    function _addRecipient(address sessionKey, address to) private {
        if (to == address(0)) revert ZeroAddress();
        if (_recipientIndex[sessionKey][to] != 0) return;

        address[] storage list = _recipients[sessionKey];
        if (list.length >= MAX_RECIPIENTS) revert TooManyRecipients(list.length + 1);
        list.push(to);
        _recipientIndex[sessionKey][to] = list.length;
    }
}
