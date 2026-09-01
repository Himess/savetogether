// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IYieldSource} from "./interfaces/IYieldSource.sol";

/// The two batcher entry points this adapter uses. Read from the deployed ABI,
/// not from documentation — the docs name a different share token than the
/// batcher actually holds.
interface IVaultBatcher {
    function currentBatchId() external view returns (uint256);
    function batchState(uint256 batchId) external view returns (uint8);
    function claim(uint256 batchId, address account) external;
    function dispatchBatch() external;
    function unwrapRequestId(uint256 batchId) external view returns (bytes32);
    function toToken() external view returns (address);
}

/**
 * Sits SaveTogether on Zama's own confidential vault instead of beside it.
 *
 * The composition is the point. GhostLend made the same argument one product
 * earlier: use the ecosystem's real confidential primitive rather than a
 * lookalike. Here that means the pool's principal reaches
 * `DepositVaultBatcherConfidential` on Sepolia and comes back as confidential
 * vault shares.
 *
 * HOW THE VAULT ACTUALLY WORKS, measured rather than assumed. A deposit is not
 * a transfer; it is joining a batch that settles later:
 *
 *   join -> dispatchBatch -> KMS callback -> claim
 *
 * Every step is permissionless. Batch 270 ran the whole cycle in about sixteen
 * blocks, and six cycles completed in the last nine thousand, so this is a live
 * path rather than a dormant one. A contract joins by calling
 * `confidentialTransferAndCall` — the batcher's receiver hook takes the token's
 * `from` as the beneficiary, so there is no input proof to forge and no operator
 * to grant.
 *
 * WHY THE DEMO DOES NOT RUN ON THIS, stated here rather than discovered later:
 *
 *   1. The deployed instance is staging, with an idle-only VaultV2 and no yield
 *      adapter. It produces zero yield, so a prize pool fed from it never fills.
 *   2. Settlement is asynchronous. Putting a batch round trip in the middle of a
 *      three-minute recording buys nothing and costs the demo its pace.
 *
 * So redemption here is served from this contract's own liquidity rather than by
 * unwinding vault shares on demand. When the buffer cannot cover a redemption
 * the transfer clamps, and the pool credits the shortfall back to the
 * withdrawer's balance — it books what moved, never what was asked for. That is
 * the same arithmetic the pool already relies on, not a special case.
 */
contract ZamaVaultSource is IYieldSource, ZamaEthereumConfig {
    /// cUSDC on Sepolia. The batcher only accepts its own `fromToken`.
    IERC7984 public immutable token;
    IVaultBatcher public immutable depositBatcher;
    IVaultBatcher public immutable redeemBatcher;

    /// The pool. Only it may supply or redeem.
    address public immutable controller;

    euint64 private _principal;

    /// Batches this adapter has joined and not yet claimed.
    uint256[] private _openBatches;

    event JoinedVault(uint256 indexed batchId, uint40 timestamp);
    event ClaimedShares(uint256 indexed batchId, uint40 timestamp);

    error OnlyController();

    constructor(
        IERC7984 token_,
        IVaultBatcher depositBatcher_,
        IVaultBatcher redeemBatcher_,
        address controller_
    ) {
        token = token_;
        depositBatcher = depositBatcher_;
        redeemBatcher = redeemBatcher_;
        controller = controller_;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert OnlyController();
        _;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function principal() external view returns (euint64) {
        return _principal;
    }

    function openBatches() external view returns (uint256[] memory) {
        return _openBatches;
    }

    /// Takes principal in and holds it. `joinVault` moves it on when a keeper says so.
    function supply(euint64 amount) external onlyController returns (euint64 supplied) {
        FHE.allowTransient(amount, address(token));
        supplied = token.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 next) = FHESafeMath.tryAdd(_principal, supplied);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(supplied, msg.sender);
    }

    /**
     * Sends `amount` into the vault's current deposit batch.
     *
     * Separate from `supply` on purpose. Joining is asynchronous and a deposit
     * must not be able to fail because a batch was mid-dispatch, so the user's
     * path and the vault's path are decoupled: the pool credits the depositor
     * immediately, and a keeper moves liquidity into the vault on its own clock.
     */
    function joinVault() external returns (uint256 batchId) {
        // Joins with whatever this contract holds. A keeper needs no handle and
        // no allowance to call it — the token grants an account ACL over its own
        // balance, so the adapter can spend it without anyone passing it in.
        euint64 amount = token.confidentialBalanceOf(address(this));
        batchId = depositBatcher.currentBatchId();
        FHE.allowTransient(amount, address(token));
        // The batcher's hook reads the token's `from` as the beneficiary, so
        // this contract joins on its own behalf and `data` is ignored.
        token.confidentialTransferAndCall(address(depositBatcher), amount, "");
        _openBatches.push(batchId);
        emit JoinedVault(batchId, uint40(block.timestamp));
    }

    /// Collects vault shares once a batch has settled. Permissionless.
    function claimShares(uint256 batchId) external {
        depositBatcher.claim(batchId, address(this));
        emit ClaimedShares(batchId, uint40(block.timestamp));
    }

    /**
     * Returns principal from this contract's liquidity.
     *
     * It does not unwind vault shares, and that is a limitation rather than an
     * oversight: unwinding is a batch round trip, so an on-demand redemption
     * would make withdrawal asynchronous. Whatever the buffer cannot cover, the
     * token declines to move, and the pool credits the difference back.
     */
    function redeem(euint64 amount, address to) external onlyController returns (euint64 sent) {
        (ebool within, euint64 decreased) = FHESafeMath.tryDecrease(_principal, amount);
        euint64 request = FHE.select(within, amount, FHE.asEuint64(0));

        FHE.allowTransient(request, address(token));
        sent = token.confidentialTransfer(to, request);

        euint64 refund = FHE.sub(request, sent);
        (, euint64 next) = FHESafeMath.tryAdd(decreased, refund);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(sent, msg.sender);
    }

    /**
     * Pays nothing, and says so.
     *
     * The deployed vault is a staging instance with no yield adapter — A9
     * measured that on chain — so there is no appreciation to harvest. Returning
     * an encrypted zero is the honest answer; inventing a rate here would make
     * this adapter a second mock wearing the real vault's address.
     */
    function harvest(address) external returns (euint64 harvested) {
        harvested = FHE.asEuint64(0);
        FHE.allowThis(harvested);
        FHE.allow(harvested, msg.sender);
    }
}
