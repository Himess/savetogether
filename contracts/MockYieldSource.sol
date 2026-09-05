// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint128, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IYieldSource} from "./interfaces/IYieldSource.sol";

/**
 * A yield source that accrues at a fixed rate. HONESTLY A MOCK.
 *
 * What is simulated and what is not, stated plainly because the distinction is
 * the whole reason this ships next to `ZamaVaultSource`:
 *
 *   SIMULATED  where the yield comes from. This contract is pre-funded with a
 *              pot and pays out of it. Nothing is invested; no strategy exists.
 *   REAL       how much, and when. Yield is `principal x rate x elapsed`,
 *              computed homomorphically on the encrypted principal, so the
 *              amount is a genuine function of what the pool holds and how long
 *              it has held it — not a number a keeper types in.
 *
 * The usual shortcut is to have a keeper mint into the vault, which makes the
 * amount arbitrary. This computes it instead, and that is the part worth
 * demonstrating: the prize really is proportional to deposits over time.
 *
 * The pot runs out eventually. `confidentialTransfer` clamps rather than
 * reverting, so an exhausted pot pays what it has and the shortfall stays booked
 * as owed. That is the correct failure, and it is visible in the reserve rather
 * than hidden in a revert.
 */
contract MockYieldSource is IYieldSource, ZamaEthereumConfig {
    IERC7984 public immutable token;

    /// Annualised rate in basis points. 500 = 5% a year.
    uint64 public immutable rateBps;

    /// The only account allowed to supply and redeem — the pool.
    address public immutable controller;

    uint40 public lastAccrual;
    euint64 private _principal;

    /**
     * Accrued but not yet paid.
     *
     * Yield has to be banked here before the principal changes. Rolling the
     * clock forward without settling would silently discard everything earned
     * since the last touch, and a deposit would erase the interest of everyone
     * already in — which is exactly the unfairness the pool's TWAB exists one
     * layer up to prevent.
     */
    euint64 private _pending;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    event Supplied(uint40 timestamp);
    event Redeemed(address indexed to, uint40 timestamp);
    event Harvested(address indexed to, uint40 timestamp, uint256 elapsed);

    error OnlyController();

    constructor(IERC7984 token_, uint64 rateBps_, address controller_) {
        token = token_;
        rateBps = rateBps_;
        controller = controller_;
        lastAccrual = uint40(block.timestamp);
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

    function pending() external view returns (euint64) {
        return _pending;
    }

    /**
     * Pulls principal in.
     *
     * Settles first: supplying changes the balance the rate applies to, and
     * banking the old balance's interest before the new one lands is what stops
     * a late depositor earning on time they were not present for.
     */
    function supply(euint64 amount) external onlyController returns (euint64 supplied) {
        _settle();
        FHE.allowTransient(amount, address(token));
        supplied = token.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 next) = FHESafeMath.tryAdd(_principal, supplied);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(supplied, msg.sender);
        emit Supplied(uint40(block.timestamp));
    }

    /// Returns principal. Settles first, for the same reason `supply` does.
    function redeem(euint64 amount, address to) external onlyController returns (euint64 sent) {
        _settle();
        (ebool within, euint64 decreased) = FHESafeMath.tryDecrease(_principal, amount);
        euint64 request = FHE.select(within, amount, FHE.asEuint64(0));

        FHE.allowTransient(request, address(token));
        sent = token.confidentialTransfer(to, request);

        // Whatever the token declined to move stays booked as principal.
        euint64 refund = FHE.sub(request, sent);
        (, euint64 next) = FHESafeMath.tryAdd(decreased, refund);
        _principal = next;
        FHE.allowThis(_principal);
        FHE.allow(sent, msg.sender);
        emit Redeemed(to, uint40(block.timestamp));
    }

    /**
     * Pays out everything accrued since the last settlement.
     *
     * Permissionless by design: the amount depends only on elapsed time and the
     * principal, so calling it early gains nothing and calling it often gains
     * nothing. A keeper runs it before each draw.
     */
    function harvest(address to) external returns (euint64 harvested) {
        _settle();

        euint64 owed = _pending;
        if (!FHE.isInitialized(owed)) {
            harvested = FHE.asEuint64(0);
            FHE.allowThis(harvested);
            FHE.allow(harvested, msg.sender);
            return harvested;
        }

        FHE.allowTransient(owed, address(token));
        harvested = token.confidentialTransfer(to, owed);

        // A dry pot pays what it has; the rest stays owed rather than being
        // forgotten, so the debt survives a top-up.
        _pending = FHE.sub(owed, harvested);
        FHE.allowThis(_pending);
        FHE.allowThis(harvested);
        FHE.allow(harvested, msg.sender);
        emit Harvested(to, uint40(block.timestamp), 0);
    }

    /// Banks interest for the elapsed interval and restarts the clock.
    function _settle() private {
        uint256 elapsed = block.timestamp - lastAccrual;
        lastAccrual = uint40(block.timestamp);
        if (elapsed == 0 || !FHE.isInitialized(_principal)) return;

        (, euint64 next) = FHESafeMath.tryAdd(_pending, _accrued(elapsed));
        _pending = next;
        FHE.allowThis(_pending);
    }

    /**
     * `principal x rateBps x elapsed / (10000 x 365 days)`, at 128 bits.
     *
     * The widening is not caution. A 1e12 principal times a basis-point rate
     * times a week of seconds is about 3e20, which passes 2^64 by more than an
     * order of magnitude — computed at 64 bits it would wrap silently, and an
     * FHE multiply has no revert to notice it happening.
     */
    function _accrued(uint256 elapsed) private returns (euint64) {
        euint128 numerator = FHE.mul(
            FHE.asEuint128(_principal),
            uint128(uint256(rateBps) * elapsed)
        );
        return FHE.asEuint64(FHE.div(numerator, uint128(BPS * YEAR)));
    }
}
