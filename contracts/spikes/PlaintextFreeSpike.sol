// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";

/**
 * SCRATCH HARNESS — spike only. Never deployed alongside the pool, never merged.
 *
 * Prices four ways of getting value into a contract, on the same token, with
 * identical bookkeeping, so the difference between the numbers is the mechanism
 * and nothing else.
 *
 *   A  depositExternal   the path the pool ships today: the caller encrypts a
 *                        plaintext off chain and hands over a ciphertext plus
 *                        an input proof. Somebody, somewhere, saw the amount.
 *
 *   B  onConfidentialTransferReceived
 *                        deposit-all. The USER calls the token with the handle
 *                        of their own balance. No plaintext is chosen, so none
 *                        exists; the handle is a public bytes32 read from a view
 *                        function. This needs no ACL grant, because ERC7984's
 *                        `_update` does `FHE.allow(ptr, from)` — the holder is
 *                        already allowed on their own balance.
 *
 *   C  depositShifted    a fraction, by shifting: half, quarter, eighth. The
 *                        contract has to COMPUTE on the balance handle, so it
 *                        needs ACL access the holder must grant first.
 *
 *   D  depositDivided    the same, by scalar division, which buys arbitrary
 *                        denominators. Priced because C only reaches powers of
 *                        two and "a third of my balance" is a thing people say.
 *
 * Bookkeeping is one `tryAdd` in every path. The real pool does more (two TWAB
 * pushes and a yield-source forward), and adding that here would bury the
 * comparison under work that is identical across all four.
 */
contract PlaintextFreeSpike is ZamaEthereumConfig, IERC7984Receiver {
    IERC7984 public immutable asset;

    mapping(address => euint64) private _credited;

    /// Which path produced a credit, so a run can be read off the logs.
    event Credited(address indexed who, string path);

    error NotTheAsset();

    constructor(IERC7984 asset_) {
        asset = asset_;
    }

    function creditedOf(address who) external view returns (euint64) {
        return _credited[who];
    }

    // ---------------------------------------------------------------- A ----

    /** The path in production today. Baseline. */
    function depositExternal(externalEuint64 encAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encAmount, inputProof);
        FHE.allowTransient(amount, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), amount);
        _credit(msg.sender, received, "A external");
    }

    // ---------------------------------------------------------------- B ----

    /**
     * Deposit-all, arriving as a transfer the user initiated.
     *
     * The user calls `token.confidentialTransferAndCall(spike, balanceHandle, "")`.
     * `msg.sender` at the token is the user, and the require there is
     * `FHE.isAllowed(amount, msg.sender)` — true for a holder's own balance. So
     * this path needs no encryption, no input proof, and no ACL grant.
     */
    function onConfidentialTransferReceived(
        address,
        address from,
        euint64 amount,
        bytes calldata
    ) external override returns (ebool) {
        if (msg.sender != address(asset)) revert NotTheAsset();
        _credit(from, amount, "B transfer-and-call");

        // The token computes on this value -- FHE.select(success, 0, sent) in
        // _transferAndCall -- so it needs ACL access to it. Without this the
        // transfer reverts with ACLNotAllowed(retval, token) from
        // FHEVMExecutor.sol:37, which is the interface note made concrete.
        ebool ok = FHE.asEbool(true);
        FHE.allowTransient(ok, msg.sender);
        return ok;
    }

    // ---------------------------------------------------------------- C ----

    /**
     * A power-of-two fraction of the caller's balance.
     *
     * `shift` 1 is half, 2 a quarter, 3 an eighth. Requires the caller to have
     * run `ACL.allow(balanceHandle, address(this))` first: this contract has to
     * compute on the handle, and the token only ever grants the holder and
     * itself.
     *
     * The handle is passed in rather than read here because reading it costs an
     * extra external call and changes nothing about what is disclosed — it is a
     * public view either way.
     */
    function depositShifted(euint64 balanceHandle, uint8 shift) external {
        euint64 part = FHE.shr(balanceHandle, shift);
        FHE.allowTransient(part, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), part);
        _credit(msg.sender, received, "C shifted");
    }

    // ---------------------------------------------------------------- D ----

    /** The same, by scalar division, for denominators that are not powers of two. */
    function depositDivided(euint64 balanceHandle, uint64 denominator) external {
        euint64 part = FHE.div(balanceHandle, denominator);
        FHE.allowTransient(part, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), part);
        _credit(msg.sender, received, "D divided");
    }

    // -----------------------------------------------------------------------

    function _credit(address who, euint64 amount, string memory path) private {
        (, euint64 next) = FHESafeMath.tryAdd(_credited[who], amount);
        FHE.allowThis(next);
        FHE.allow(next, who);
        _credited[who] = next;
        emit Credited(who, path);
    }
}
