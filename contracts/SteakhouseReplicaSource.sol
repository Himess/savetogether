// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint128, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IYieldSource} from "./interfaces/IYieldSource.sol";

interface IDepositBatcher {
    function currentBatchId() external view returns (uint256);
    function claim(uint256 batchId, address account) external;
    /// The confidential share token this batcher mints into. Read, never guessed.
    function toToken() external view returns (address);
}

/**
 * Zama's redeem batcher — the mirror of the deposit one.
 *
 * `fromToken` is the confidential share, `toToken` is cUSDC, and `vault()` is the
 * same ERC-4626 both sides settle against. Checked on chain rather than taken
 * from the address reference, which lists a different cShare than the one the
 * deposit batcher actually mints (`Confidential mvUSDC` against the
 * `csteakcUSDC (Mock)` that is really used).
 */
interface IRedeemBatcher {
    function currentBatchId() external view returns (uint256);
    function claim(uint256 batchId, address account) external;
    function fromToken() external view returns (address);
    function toToken() external view returns (address);
}

/**
 * The testnet replica of Steakhouse Confidential Prime, with the pool on top.
 *
 * WHAT THIS IS. On mainnet, confidential USDC earns in a Steakhouse x Morpho
 * vault. That vault is mainnet-only, so this is a replica of its shape on
 * Sepolia: our contract, our rate, labelled as a stand-in everywhere it is
 * shown. It is NOT the live
 * mainnet vault and is not affiliated with Steakhouse Financial or Morpho.
 *
 * WHY IT IS NOT SIMPLY A MOCK. Principal deposited here does not sit in a
 * pretend vault. `joinVault` moves it into Zama's DEPLOYED confidential vault
 * batcher and real shares come back when their keeper dispatches — the same
 * composition `ZamaVaultSource` proved on chain, kept rather than dropped. So
 * the pool is genuinely wired to Zama's vault layer, and the yield on top is
 * the replica's.
 *
 * THE HONEST SPLIT, and it is the whole reason this contract exists as one
 * piece rather than two:
 *
 *   - the VAULT COMPOSITION is real. Real batcher, real shares, on chain.
 *   - the YIELD is ours. Zama's Sepolia vault has no yield adapter — A9
 *     measured that — so nothing about it appreciates, and a prize funded from
 *     its appreciation would never be paid. The rate here is the replica's,
 *     driven by us, and every screen that shows it says so.
 *
 * Merging them is what makes the product demonstrable AND composed. Splitting
 * them, as the previous design did, meant choosing between a pool that pays and
 * a pool that composes, and shipping the one that pays with the other beside it
 * unused.
 */
contract SteakhouseReplicaSource is IYieldSource, ZamaEthereumConfig {
    IERC7984 public immutable token;
    IDepositBatcher public immutable depositBatcher;

    /**
     * The way back out, which the first version of this contract did not have.
     *
     * Zama's vault is served by a PAIR of batchers, and the mainnet product works
     * the same way — app.zama.org offers Deposit and Withdraw against the same
     * Steakhouse Confidential Prime vault, one batching cUSDC in and the other
     * batching shares out. Composing with only half of that made "principal is
     * withdrawable at any time" depend on a buffer rather than on the vault, and
     * the limitation was documented instead of fixed.
     *
     * Both are read off the deposit batcher rather than passed in, so the share
     * token cannot drift from the one the batcher actually mints.
     */
    IRedeemBatcher public immutable redeemBatcher;
    IERC7984 public immutable shareToken;

    /// The replica's rate, in basis points a year. Ours, and labelled as ours.
    uint64 public immutable rateBps;

    /// Only the pool may supply or redeem. Joining and harvesting are open.
    address public immutable controller;

    uint40 public lastAccrual;
    euint64 private _principal;
    euint64 private _pending;

    /// B2. Principal already sent to the vault, so "half" means half of the rest.
    euint64 private _inVault;

    /// Batches joined and not yet claimed.
    uint256[] private _openBatches;

    /// Redeem batches asked for and not yet collected.
    uint256[] private _openRedeems;

    event JoinedVault(uint256 indexed batchId, uint40 at);
    event ClaimedShares(uint256 indexed batchId, uint40 at);
    event RequestedUnwind(uint256 indexed batchId, uint40 at);
    event ClaimedUnwound(uint256 indexed batchId, uint40 at);

    error NotController();

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    error BatcherMismatch();

    constructor(
        IERC7984 token_,
        IDepositBatcher depositBatcher_,
        IRedeemBatcher redeemBatcher_,
        uint64 rateBps_,
        address controller_
    ) {
        token = token_;
        depositBatcher = depositBatcher_;
        redeemBatcher = redeemBatcher_;

        // The share token is whatever the deposit batcher mints, and the redeem
        // batcher must consume exactly that and return exactly our asset. Asserted
        // here rather than assumed, because the two batchers are separate
        // deployments and a mismatched pair would send shares somewhere they can
        // never come back from — and the published address reference already lists
        // the wrong cShare, so "it is in the docs" is not a check.
        address share = depositBatcher_.toToken();
        if (redeemBatcher_.fromToken() != share) revert BatcherMismatch();
        if (redeemBatcher_.toToken() != address(token_)) revert BatcherMismatch();
        shareToken = IERC7984(share);

        rateBps = rateBps_;
        controller = controller_;
        lastAccrual = uint40(block.timestamp);
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function principal() external view returns (euint64) {
        return _principal;
    }

    function pending() external view returns (euint64) {
        return _pending;
    }

    function openBatches() external view returns (uint256[] memory) {
        return _openBatches;
    }

    // ------------------------------------------------------------ the pool --

    function supply(euint64 amount) external onlyController returns (euint64 supplied) {
        _settle();
        FHE.allowTransient(amount, address(token));
        supplied = token.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 next) = FHESafeMath.tryAdd(_principal, supplied);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(supplied, msg.sender);
    }

    /**
     * Returns principal from this contract's liquidity.
     *
     * It pays from the buffer and does not unwind shares INLINE, which is a
     * different statement from the one this comment used to make. Unwinding is a
     * batch round trip on Zama's keeper's clock, so doing it inside a withdrawal
     * would make every withdrawal asynchronous — the wrong trade for the common
     * case, where the buffer covers it and the money is instant.
     *
     * What changed is that the money is no longer stranded when the buffer does
     * not cover it. `requestUnwind` brings it back through Zama's redeem batcher,
     * which is how the mainnet product works too: app.zama.org has a Withdraw tab
     * against this same vault, batched, and it says so on the screen. Whatever
     * the buffer cannot cover the token declines to move, the pool credits the
     * difference back, and a smaller ask — or the same ask after a batch settles
     * — goes through.
     */
    function redeem(euint64 amount, address to) external onlyController returns (euint64 sent) {
        _settle();
        FHE.allowTransient(amount, address(token));
        sent = token.confidentialTransfer(to, amount);
        (, euint64 next) = FHESafeMath.tryDecrease(_principal, sent);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(sent, msg.sender);
    }

    /**
     * Moves accrued yield to the pool's reserve.
     *
     * Permissionless, and the number is the replica's own: `principal x rate x
     * elapsed`, computed at 128 bits on the encrypted principal. The prize is
     * funded from this and from nothing else — the pool's reserve starts empty.
     */
    function harvest(address to) external returns (euint64 harvested) {
        _settle();
        harvested = _pending;
        if (!FHE.isInitialized(harvested)) {
            harvested = FHE.asEuint64(0);
            FHE.allowThis(harvested);
            FHE.allow(harvested, msg.sender);
            return harvested;
        }
        FHE.allowTransient(harvested, address(token));
        euint64 sent = token.confidentialTransfer(to, harvested);
        (, euint64 left) = FHESafeMath.tryDecrease(_pending, sent);
        _pending = left;
        FHE.allowThis(_pending);
        FHE.allow(sent, msg.sender);
        return sent;
    }

    // ----------------------------------------------------------- the vault --

    /**
     * Sends what this contract holds into Zama's next deposit batch.
     *
     * A contract cannot call the vault's `join` — it takes an externally
     * encrypted input and a proof no contract can forge — so the way in is the
     * ERC-7984 receiver hook: `confidentialTransferAndCall` makes the batcher's
     * `onConfidentialTransferReceived` fire, and it reads the token's `from` as
     * the beneficiary. This contract therefore joins on its own behalf.
     *
     * Permissionless: it moves this contract's own balance and cannot send value
     * anywhere the adapter had not already chosen.
     */
    function joinVault() external returns (uint256 batchId) {
        // HALF OF WHAT IS STILL HERE, and every word of that is load-bearing.
        //
        // Not the whole balance: this contract also holds the pot its yield is
        // paid from, and joining that would send the prize reserve into the
        // vault and leave the pool unable to pay anything. Balance and principal
        // are different numbers here and only one of them is the depositors'.
        //
        // Not all the principal either: a batch is a round trip on Zama's
        // keeper's clock, and this contract does not unwind shares on demand, so
        // sending everything would make withdrawal asynchronous. Half is the
        // liquidity buffer a real vault keeps, for the same reason.
        //
        // B2. And not half of the SAME number every time, which is what the
        // first version did. It shifted `_principal` and never decremented it,
        // so "half" meant half of the original on every call and the function was
        // permissionless: two calls moved the whole principal, more reached the
        // pot. Nothing was stolen — the batcher credits this contract and
        // `claimShares` recovers it — but liquidity is what got spent, and
        // *principal is withdrawable at any time* is a liquidity claim.
        // `test/withdraw-buffer.ts` pinned it before this fix existed.
        (, euint64 remaining) = FHESafeMath.tryDecrease(_principal, _inVault);
        euint64 amount = FHE.shr(remaining, 1);
        (, euint64 nextInVault) = FHESafeMath.tryAdd(_inVault, amount);
        _inVault = nextInVault;
        FHE.allowThis(_inVault);

        batchId = depositBatcher.currentBatchId();
        FHE.allowTransient(amount, address(token));
        token.confidentialTransferAndCall(address(depositBatcher), amount, "");
        _openBatches.push(batchId);
        emit JoinedVault(batchId, uint40(block.timestamp));
    }

    /**
     * How much principal is in the vault rather than here.
     *
     * Encrypted, and it stays that way: it is a strict function of the principal,
     * so publishing it would publish a fixed fraction of the pool's deposits.
     *
     * It is why `joinVault` can stay permissionless now. Before, the function was
     * safe in its DESTINATION — it could only send value where the adapter had
     * already chosen — and that was mistaken for being safe in its EFFECT.
     * Bounded, repetition converges rather than draining: each call moves half of
     * what remains, so the buffer approaches zero without reaching it, and the
     * pot is never touched at all.
     */
    function inVault() external view returns (euint64) {
        return _inVault;
    }

    /// Collects vault shares once a batch has settled. Permissionless.
    function claimShares(uint256 batchId) external {
        depositBatcher.claim(batchId, address(this));
        emit ClaimedShares(batchId, uint40(block.timestamp));
    }

    /**
     * Sends every vault share back through Zama's redeem batcher.
     *
     * The mirror of `joinVault`, and the reason it exists is that without it
     * "principal is withdrawable at any time" rested on a buffer rather than on
     * the vault: whatever had been joined could only come back if somebody
     * happened to deposit more. Zama's own app has both directions against this
     * same vault, so composing with only one half was a gap in the replica rather
     * than a property of the design.
     *
     * ALL of the shares, not half. `joinVault` keeps a buffer because entering is
     * optional and reversible; leaving is the recovery path, and a recovery path
     * that only recovers half is not one. The batch is still Zama's keeper's
     * clock — this asks, it does not withdraw.
     *
     * Permissionless for the same reason `joinVault` is: it moves this contract's
     * own shares to a destination fixed in the constructor, and unwinding can only
     * ever increase the liquidity available to depositors.
     */
    function requestUnwind() external returns (uint256 batchId) {
        euint64 shares = shareToken.confidentialBalanceOf(address(this));
        batchId = redeemBatcher.currentBatchId();
        FHE.allowTransient(shares, address(shareToken));
        shareToken.confidentialTransferAndCall(address(redeemBatcher), shares, "");
        _openRedeems.push(batchId);
        emit RequestedUnwind(batchId, uint40(block.timestamp));
    }

    /**
     * Collects the cUSDC a settled redeem batch returned, and books it.
     *
     * `claim` returns nothing, so how much came back is measured as the change in
     * this contract's own balance rather than taken from a return value. That is
     * not defensive style — it is the only way to know, and it is also the only
     * version that stays correct once the vault has real yield: what comes out is
     * shares times a price that moved, not what went in.
     *
     * `_principal` is untouched. The depositors' claim did not change because the
     * money moved between two places this contract controls; only `_inVault` does,
     * so the next `joinVault` sees the buffer that actually exists.
     */
    function claimUnwound(uint256 batchId) external {
        euint64 before = token.confidentialBalanceOf(address(this));
        redeemBatcher.claim(batchId, address(this));
        euint64 present = token.confidentialBalanceOf(address(this));

        (, euint64 returned) = FHESafeMath.tryDecrease(present, before);
        (, euint64 left) = FHESafeMath.tryDecrease(_inVault, returned);
        _inVault = left;
        FHE.allowThis(_inVault);

        emit ClaimedUnwound(batchId, uint40(block.timestamp));
    }

    /// Redeem batches asked for and not yet collected.
    function openRedeems() external view returns (uint256[] memory) {
        return _openRedeems;
    }

    // ----------------------------------------------------------------------

    /**
     * Banks what has accrued since the last touch, before principal moves.
     *
     * Without this, rolling the clock forward on a changed principal would
     * discard the interest earned by the old one — a bug this codebase has
     * already paid for once, in `MockYieldSource`.
     */
    function _settle() private {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return;
        lastAccrual = uint40(block.timestamp);
        if (!FHE.isInitialized(_principal)) return;

        euint64 earned = _accrued(elapsed);
        (, euint64 next) = FHESafeMath.tryAdd(_pending, earned);
        _pending = next;
        FHE.allowThis(_pending);
    }

    /// `principal x rateBps x elapsed / (10000 x 365 days)`, at 128 bits.
    function _accrued(uint256 elapsed) private returns (euint64) {
        euint128 numerator = FHE.mul(
            FHE.asEuint128(_principal),
            uint128(uint256(rateBps) * elapsed)
        );
        euint64 out = FHE.asEuint64(FHE.div(numerator, uint128(10_000 * uint256(365 days))));
        FHE.allowThis(out);
        return out;
    }
}
