// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @title SummonPrice
/// @notice Spec 001 §5.1. Pyth gives the underlying share price; a B20 tokenized stock is worth
///         underlying × multiplier per whole token. This is the only place the multiplier is applied,
///         and it is applied exactly once. (Chainlink's Base equity feeds are already total-return and
///         must not go through here.)
library SummonPrice {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant USDC_TO_WAD = 1e12; // USDC has 6 decimals

    error BadPythPrice();
    error BadMultiplier();
    error BadDecimals();
    error SpreadTooWide();

    /// USD per whole token, 18 decimals: underlying share price (18 decimals, as PythRef returns it)
    /// × multiplier (WAD).
    function refPerToken(uint256 underlyingWad, uint256 multiplier) internal pure returns (uint256) {
        if (underlyingWad == 0) revert BadPythPrice();
        if (multiplier == 0) revert BadMultiplier();
        return underlyingWad * multiplier / WAD;
    }

    /// USDC (6 decimals) owed for `qRaw` raw token units at `ref` × (1 + spreadBps), rounded down
    /// (against the filler, who receives it).
    function usdcFor(uint256 qRaw, uint256 ref, uint256 spreadBps, uint8 tokenDecimals)
        internal
        pure
        returns (uint256)
    {
        _checkArgs(spreadBps, tokenDecimals);
        return qRaw * ref * (BPS + spreadBps) / (BPS * 10 ** tokenDecimals * USDC_TO_WAD);
    }

    /// Raw token units the filler must deliver for `usdc` at `ref` × (1 + spreadBps), rounded up
    /// (against the filler, who delivers them).
    function tokensFor(uint256 usdc, uint256 ref, uint256 spreadBps, uint8 tokenDecimals)
        internal
        pure
        returns (uint256)
    {
        _checkArgs(spreadBps, tokenDecimals);
        if (ref == 0) revert BadPythPrice();
        uint256 num = usdc * BPS * 10 ** tokenDecimals * USDC_TO_WAD;
        uint256 den = ref * (BPS + spreadBps);
        return (num + den - 1) / den;
    }

    function _checkArgs(uint256 spreadBps, uint8 tokenDecimals) private pure {
        if (spreadBps > BPS) revert SpreadTooWide();
        if (tokenDecimals < 6 || tokenDecimals > 18) revert BadDecimals(); // B20 Asset range
    }
}
