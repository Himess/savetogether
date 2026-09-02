// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * Enough of Zama's deposit batcher to test what joining and leaving do.
 *
 * It takes the asset through the receiver hook, remembers who handed in what, and
 * on `claim` pays out the same amount in the SHARE token. One for one, which is
 * what Zama's Sepolia vault actually does — it is idle-only with no yield
 * adapter, so a share is worth what it cost.
 *
 * Pre-fund this contract with the share token in the test; the real batcher mints
 * against the vault, and minting is not the part under test.
 *
 * The receiver hook must grant the TOKEN access to the ebool it returns, or the
 * transfer reverts with ACLNotAllowed from FHEVMExecutor — a rule this codebase
 * learned by decoding selector 0x9de3392c rather than from a document.
 */
contract MockDepositBatcher is ZamaEthereumConfig {
    uint256 public currentBatchId = 1;

    /// What this batcher mints into. The source reads it rather than being told.
    address public immutable toTokenAddr;

    /// batchId => account => what was handed in, so claim can pay shares for it.
    mapping(uint256 => mapping(address => euint64)) private _pending;

    constructor(address share_) {
        toTokenAddr = share_;
    }

    function toToken() external view returns (address) {
        return toTokenAddr;
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

    /// Pays shares one for one for whatever was handed in.
    function claim(uint256 batchId, address account) external {
        euint64 owed = _pending[batchId][account];
        if (!FHE.isInitialized(owed)) return;
        _pending[batchId][account] = FHE.asEuint64(0);
        FHE.allowThis(_pending[batchId][account]);
        FHE.allowTransient(owed, toTokenAddr);
        IERC7984(toTokenAddr).confidentialTransfer(account, owed);
    }

    function advance() external {
        currentBatchId += 1;
    }
}
