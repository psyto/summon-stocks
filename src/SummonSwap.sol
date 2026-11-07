// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SummonSwap
/// @notice Exact-input swaps on a summoned stock's Uniswap v4 pool, and a read of its price and liquidity
///         for the round page. Holds nothing between calls: input is pulled from the caller straight into
///         the PoolManager, output goes straight to `to`.
contract SummonSwap is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error TooLittleReceived(uint256 out, uint256 minOut);
    error ZeroAmount();
    error TransferFailed();

    event Swapped(PoolId indexed id, address indexed payer, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    struct Call {
        address payer;
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        address to;
    }

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    /// Sells exactly `amountIn` of one side for at least `minOut` of the other.
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        amountOut = abi.decode(poolManager.unlock(abi.encode(Call(msg.sender, key, zeroForOne, amountIn, minOut, to))), (uint256));
        emit Swapped(key.toId(), msg.sender, zeroForOne, amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Call memory c = abi.decode(data, (Call));
        BalanceDelta delta = poolManager.swap(
            c.key,
            IPoolManager.SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: -int256(uint256(c.amountIn)),
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency cin, Currency cout) = c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        (int128 dIn, int128 dOut) = c.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        // a price limit can stop a swap early; the caller pays only what the pool took
        uint256 paid = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        if (out < c.minOut) revert TooLittleReceived(out, c.minOut);

        poolManager.sync(cin);
        if (!IERC20Pull(Currency.unwrap(cin)).transferFrom(c.payer, address(poolManager), paid)) revert TransferFailed();
        poolManager.settle();
        poolManager.take(cout, c.to, out);
        return abi.encode(out);
    }

    /// The pool's current sqrt price, tick and in-range liquidity.
    function poolState(PoolKey calldata key) external view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        PoolId id = key.toId();
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(id);
        liquidity = poolManager.getLiquidity(id);
    }
}
