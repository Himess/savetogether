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
}

/**
 * The testnet replica of Steakhouse Confidential Prime, with the pool on top.
 *
 * WHAT THIS IS. On mainnet, confidential USDC earns in a Steakhouse x Morpho
 * vault. That vault is mainnet-only, so this is a replica of its shape on
 * Sepolia — and it is a replica in the same sense GhostLend's was: our contract,
 * our rate, labelled as a stand-in everywhere it is shown. It is NOT the live
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

    /// The replica's rate, in basis points a year. Ours, and labelled as ours.
    uint64 public immutable rateBps;

    /// Only the pool may supply or redeem. Joining and harvesting are open.
    address public immutable controller;

    uint40 public lastAccrual;
    euint64 private _principal;
    euint64 private _pending;

    /// Batches joined and not yet claimed.
    uint256[] private _openBatches;

    event JoinedVault(uint256 indexed batchId, uint40 at);
    event ClaimedShares(uint256 indexed batchId, uint40 at);

    error NotController();

    modifier onlyController() {
        if (msg.sender != controller) revert NotController();
        _;
    }

    constructor(
        IERC7984 token_,
        IDepositBatcher depositBatcher_,
        uint64 rateBps_,
        address controller_
    ) {
        token = token_;
        depositBatcher = depositBatcher_;
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
     * It does not unwind vault shares, and that is a limitation rather than an
     * oversight: unwinding is a batch round trip, so an on-demand redemption
     * would make withdrawal asynchronous. Whatever the buffer cannot cover, the
     * token declines to move and the pool credits the difference back.
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
        // HALF THE PRINCIPAL, and neither half of that is arbitrary.
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
        euint64 amount = FHE.shr(_principal, 1);
        batchId = depositBatcher.currentBatchId();
        FHE.allowTransient(amount, address(token));
        token.confidentialTransferAndCall(address(depositBatcher), amount, "");
        _openBatches.push(batchId);
        emit JoinedVault(batchId, uint40(block.timestamp));
    }

    /// Collects vault shares once a batch has settled. Permissionless.
    function claimShares(uint256 batchId) external {
        depositBatcher.claim(batchId, address(this));
        emit ClaimedShares(batchId, uint40(block.timestamp));
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
