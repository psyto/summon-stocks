// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";

/// @title SummonPool
/// @notice Spec 001 §5.5: the full-range seed. The starting price is the ratio of the two seed amounts,
///         which were both computed at the reference price, so the pool opens at that price. The fee is
///         dynamic: SummonHook sets it on every swap from the stock's market state.
library SummonPool {
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant FEE = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    uint24 internal constant OPEN_FEE = 3000; // 0.30%, while the listing exchange is open
    uint24 internal constant CLOSED_FEE = 10_000; // 1.00%, while it is closed or the guard is quiet

    error RatioOutOfRange();

    function tickLower() internal pure returns (int24) {
        return TickMath.minUsableTick(TICK_SPACING);
    }

    function tickUpper() internal pure returns (int24) {
        return TickMath.maxUsableTick(TICK_SPACING);
    }

    /// sqrt(amount1 / amount0) in Q64.96, from raw amounts of currency0 and currency1.
    function sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert RatioOutOfRange();
        // ratio in Q192; reverts (FullMath) when amount1 / amount0 >= 2^64
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint256 r = sqrt(ratioX192);
        if (r < TickMath.MIN_SQRT_PRICE || r >= TickMath.MAX_SQRT_PRICE) revert RatioOutOfRange();
        return uint160(r);
    }

    /// Largest liquidity the two amounts support over the full range at `sqrtP`.
    function fullRangeLiquidity(uint160 sqrtP, uint256 amount0, uint256 amount1) internal pure returns (uint128) {
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower());
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper());
        // L0 = amount0 * sqrtP * sb / ((sb - sqrtP) * Q96); L1 = amount1 * Q96 / (sqrtP - sa)
        uint256 l0 = FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtP, FixedPoint96.Q96), sb, sb - sqrtP);
        uint256 l1 = FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtP - sa);
        uint256 l = l0 < l1 ? l0 : l1;
        if (l > type(uint128).max) revert RatioOutOfRange();
        return uint128(l);
    }

    /// `sqrtP` with the price scaled by `num / den` (§5.5a). The price is (sqrtP / 2^96)^2, so sqrtP scales
    /// by sqrt(num / den); both are 1e18-scaled multipliers, taken to 1e36 first for precision.
    function scaledSqrtPrice(uint160 sqrtP, uint256 num, uint256 den) internal pure returns (uint160) {
        uint256 r = FullMath.mulDiv(sqrtP, sqrt(num * 1e18), sqrt(den * 1e18));
        if (r < TickMath.MIN_SQRT_PRICE || r >= TickMath.MAX_SQRT_PRICE) revert RatioOutOfRange();
        return uint160(r);
    }

    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (x >> 1) + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }
}
