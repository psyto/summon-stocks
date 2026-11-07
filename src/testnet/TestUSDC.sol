// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// @title TestUSDC
/// @notice Testnet only. A 6-decimal stand-in for USDC that anyone can mint, so demo backers can pledge
///         without a faucet. Not USDC, not affiliated with Circle.
contract TestUSDC {
    string public constant name = "Summon Test USDC (testnet, no value)";
    string public constant symbol = "tUSDC";
    uint8 public constant decimals = 6;
    uint256 public constant MAX_MINT = 100_000e6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error TooMuch();

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert TooMuch();
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
