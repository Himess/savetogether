// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/// @title  MockERC7984
/// @author SaveTogether
/// @notice Minimal concrete ERC-7984 for tests. Open mint, no access control.
/// @dev Test fixture only. Never deploy this anywhere that matters.
contract MockERC7984 is ERC7984, ZamaEthereumConfig {
    /// @notice Deploys the mock token.
    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param uri_ Contract URI.
    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_
    ) ERC7984(name_, symbol_, uri_) {}

    /// @notice Mints an externally encrypted amount.
    /// @param to Recipient.
    /// @param encAmount Encrypted amount, bound to this contract and the caller.
    /// @param inputProof Proof for `encAmount`.
    function mint(address to, externalEuint64 encAmount, bytes calldata inputProof) external {
        _mint(to, FHE.fromExternal(encAmount, inputProof));
    }

    /// @notice Mints a plaintext amount. Convenience for deterministic test fixtures.
    /// @param to Recipient.
    /// @param amount Plaintext amount, trivially encrypted on chain.
    function mintPlain(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }
}
