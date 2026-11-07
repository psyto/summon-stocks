// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {SummonRound} from "./SummonRound.sol";

/// @title SummonFactory
/// @notice Opens rounds and keeps the list. The owner binds each stock token to its price feed once, so a
///         summoner cannot open a round for a token priced off another stock's feed.
contract SummonFactory {
    struct Defaults {
        uint16 lpBps;
        uint32 rampSeconds;
        uint32 windowSeconds;
        uint8 maxAuctions;
        uint32 maxGuardAge;
        uint32 maxPythAge;
        uint16 maxConfBps;
        uint16 maxJumpBps;
        uint32 cooldownSeconds;
    }

    address public owner;
    SummonRound.Deps internal deps;
    Defaults public defaults;

    struct Feed {
        address source; // Pyth, or a feed with Pyth's read interface
        bytes32 priceId;
    }

    /// The smallest target a round may have, in USDC (6 decimals). 0 = no minimum (testnet). Set from what
    /// a fill costs the filler (an issuer's fixed cost per mint), not guessed; the owner can change it.
    uint256 public minTarget;

    mapping(address token => Feed) public feedOf;
    mapping(address token => address) public latestRound;
    mapping(bytes32 keyHash => address) public roundForPool;
    address[] public rounds;

    error NotOwner();
    error NotListed(address token);
    error RoundActive(address round);
    error TokenLive(address round);
    error AlreadyListed(address token);
    error TargetTooSmall(uint256 target, uint256 minTarget);

    event Listed(address indexed token, address source, bytes32 priceId);
    event RoundOpened(address indexed token, address round, uint256 target, uint64 deadline, uint16 maxSpreadBps);
    event OwnerTransferred(address indexed newOwner);
    event MinTargetSet(uint256 minTarget);

    constructor(address owner_, SummonRound.Deps memory deps_, Defaults memory defaults_) {
        owner = owner_;
        deps = deps_;
        defaults = defaults_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerTransferred(newOwner);
    }

    function setMinTarget(uint256 m) external onlyOwner {
        minTarget = m;
        emit MinTargetSet(m);
    }

    /// Binds a token to its price feed (source contract and feed id). Once, so a live round's feed can
    /// never change under it.
    function list(address token, address source, bytes32 priceId) external onlyOwner {
        if (feedOf[token].source != address(0)) revert AlreadyListed(token);
        if (source == address(0) || priceId == bytes32(0)) revert NotListed(token);
        feedOf[token] = Feed(source, priceId);
        emit Listed(token, source, priceId);
    }

    /// Anyone may open a round for a listed token, unless one is still running or one already filled
    /// (the token then has its Summon pool, and the pool key can only be initialized once).
    function openRound(address token, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint32 lpLockSeconds)
        external
        returns (SummonRound round)
    {
        Feed memory feed = feedOf[token];
        if (feed.source == address(0)) revert NotListed(token);
        if (target < minTarget) revert TargetTooSmall(target, minTarget);
        address prev = latestRound[token];
        if (prev != address(0)) {
            SummonRound.State s = SummonRound(prev).state();
            if (s == SummonRound.State.Filled) revert TokenLive(prev);
            if (s != SummonRound.State.Expired) revert RoundActive(prev);
        }
        Defaults memory df = defaults;
        round = new SummonRound(
            deps,
            SummonRound.Params({
                token: token,
                priceSource: feed.source,
                priceId: feed.priceId,
                target: target,
                deadline: deadline,
                maxSpreadBps: maxSpreadBps,
                lpBps: df.lpBps,
                rampSeconds: df.rampSeconds,
                windowSeconds: df.windowSeconds,
                maxAuctions: df.maxAuctions,
                lpLockSeconds: lpLockSeconds,
                maxGuardAge: df.maxGuardAge,
                maxPythAge: df.maxPythAge,
                maxConfBps: df.maxConfBps,
                maxJumpBps: df.maxJumpBps,
                cooldownSeconds: df.cooldownSeconds
            })
        );
        latestRound[token] = address(round);
        roundForPool[keccak256(abi.encode(round.poolKey()))] = address(round);
        rounds.push(address(round));
        emit RoundOpened(token, address(round), target, deadline, maxSpreadBps);
    }

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    function getDeps() external view returns (SummonRound.Deps memory) {
        return deps;
    }
}
