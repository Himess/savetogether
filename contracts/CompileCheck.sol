// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title CompileCheck
/// @author GhostKey
/// @notice Placeholder only. Proves the FHEVM toolchain compiles and links.
/// @dev `SepoliaConfig` does not exist in @fhevm/solidity 0.11.1 despite what the
///      docs say; the export is `ZamaEthereumConfig`, which dispatches on chainid
///      across mainnet, Sepolia and local. See findings.md section 6, item 4.
///      GhostKeySession.sol is step 2 and is deliberately not written yet — its
///      shape depends on what the step-1 assumption verification returned.
contract CompileCheck is ZamaEthereumConfig {
    /// @notice The single encrypted value this placeholder stores.
    euint64 private _value;

    /// @notice Stores an externally encrypted value.
    /// @param input The external ciphertext handle.
    /// @param proof The input proof produced by the relayer.
    function set(externalEuint64 input, bytes calldata proof) external {
        _value = FHE.fromExternal(input, proof);
        FHE.allowThis(_value);
        FHE.allow(_value, msg.sender);
    }

    /// @notice Returns the stored handle.
    /// @return The encrypted value handle.
    function get() external view returns (euint64) {
        return _value;
    }
}
