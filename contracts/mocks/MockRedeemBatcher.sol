// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * Enough of Zama's redeem batcher to test the way back out.
 *
 * It takes shares through the receiver hook, remembers who sent what, and on
 * `claim` pays the same amount out in the asset — a one-to-one exchange rate,
 * which is what Zama's Sepolia vault actually does because it has no yield
 * adapter. A vault with real yield would pay out shares times a moved price, and
 * `claimUnwound` measures the balance delta rather than assuming the amount for
 * exactly that reason.
 *
 * The receiver hook must grant the SHARE token access to the ebool it returns, or
 * the transfer reverts with ACLNotAllowed out of FHEVMExecutor. Same rule as the
 * deposit side, and the same rule this codebase learned by decoding a selector.
 */
contract MockRedeemBatcher is ZamaEthereumConfig {
    IERC7984 public immutable fromTokenC;
    IERC7984 public immutable toTokenC;

    uint256 public currentBatchId = 1;

    /// batchId => account => shares handed in
    mapping(uint256 => mapping(address => euint64)) private _pending;

    constructor(IERC7984 share_, IERC7984 asset_) {
        fromTokenC = share_;
        toTokenC = asset_;
    }

    function fromToken() external view returns (address) {
        return address(fromTokenC);
    }

    function toToken() external view returns (address) {
        return address(toTokenC);
    }

    function onConfidentialTransferReceived(
        address,
        address from,
        euint64 amount,
        bytes calldata
    ) external returns (ebool) {
        euint64 prior = _pending[currentBatchId][from];
        _pending[currentBatchId][from] = FHE.isInitialized(prior) ? FHE.add(prior, amount) : amount;
        FHE.allowThis(_pending[currentBatchId][from]);

        ebool ok = FHE.asEbool(true);
        FHE.allowThis(ok);
        FHE.allow(ok, msg.sender);
        return ok;
    }

    /// Settles a batch: whatever was handed in comes back in the asset, 1:1.
    function claim(uint256 batchId, address account) external {
        euint64 owed = _pending[batchId][account];
        if (!FHE.isInitialized(owed)) return;
        _pending[batchId][account] = FHE.asEuint64(0);
        FHE.allowThis(_pending[batchId][account]);
        FHE.allowTransient(owed, address(toTokenC));
        toTokenC.confidentialTransfer(account, owed);
    }

    function advance() external {
        currentBatchId += 1;
    }
}
