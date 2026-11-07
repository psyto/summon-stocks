// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IPyth} from "hl-price-guard/PythRef.sol";

/// @title GuardPriceFeed
/// @notice Testnet only. A price feed with Pyth's read interface, written by the demo guard (the same key
///         that writes halts to MarketStateRegistry). It lets the demo run while Hermes needs an API key.
///         Its prices come from a public, possibly delayed quote, so it must never back real funds: a
///         filler who sees the live market can fill only when the delayed price favors them.
///         `updatePriceFeeds` takes no data; prices arrive through `post`.
contract GuardPriceFeed {
    uint256 public constant MAX_FUTURE_SKEW = 30;

    address public immutable owner;
    mapping(address => bool) public isUpdater;
    mapping(bytes32 => IPyth.Price) internal _prices;

    error NotOwner();
    error NotUpdater();
    error BadPrice();
    error NotNewer(uint256 stored, uint256 posted);
    error NoUpdateData();
    error PriceFeedNotFound();

    event UpdaterSet(address indexed updater, bool allowed);
    event Posted(bytes32 indexed id, int64 price, uint64 conf, int32 expo, uint256 publishTime);

    constructor(address owner_) {
        owner = owner_;
    }

    function setUpdater(address u, bool ok) external {
        if (msg.sender != owner) revert NotOwner();
        isUpdater[u] = ok;
        emit UpdaterSet(u, ok);
    }

    function post(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        if (!isUpdater[msg.sender]) revert NotUpdater();
        if (price <= 0 || expo > 0 || expo < -18 || publishTime > block.timestamp + MAX_FUTURE_SKEW) revert BadPrice();
        uint256 prev = _prices[id].publishTime;
        if (publishTime <= prev) revert NotNewer(prev, publishTime);
        _prices[id] = IPyth.Price(price, conf, expo, publishTime);
        emit Posted(id, price, conf, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view returns (IPyth.Price memory p) {
        p = _prices[id];
        if (p.publishTime == 0) revert PriceFeedNotFound();
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        revert NoUpdateData();
    }
}
