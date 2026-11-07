// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @title DemoOracleRegistry
/// @notice Testnet only. Stands in for Coinbase's oracle registry on Base mainnet (0x3f3E…5CaD), which
///         has no Sepolia deployment: same read (`getOracleParams`, selector 0xd4197e82), set by the demo
///         operator so the demo can show a corporate-action pause.
contract DemoOracleRegistry {
    struct P {
        uint256 multiplier;
        bool paused;
        bool set;
    }

    address public immutable operator;
    mapping(address => P) internal _p;

    error NotOperator();

    event Set(address indexed token, uint256 multiplier, bool paused);

    constructor(address operator_) {
        operator = operator_;
    }

    function set(address token, uint256 multiplier, bool paused) external {
        if (msg.sender != operator) revert NotOperator();
        _p[token] = P(multiplier, paused, true);
        emit Set(token, multiplier, paused);
    }

    /// An unset token reads as paused, so a token the operator never configured cannot fill.
    function getOracleParams(address token) external view returns (uint256, bool) {
        P memory x = _p[token];
        if (!x.set) return (0, true);
        return (x.multiplier, x.paused);
    }
}
