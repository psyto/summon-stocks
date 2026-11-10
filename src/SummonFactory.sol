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
        // Push feed (a trusted guard posts one price at a time): the oldest price a round accepts. Pull feed
        // (Pyth, where the caller supplies the update): the settlement window; a round settles on the first
        // print at or after the start of the previous window, which no caller chooses (Codex r2 #1, r3 #2).
        uint32 maxAge;
        bool pull;
    }

    /// A round lasts at most this long, and locks its LP position at most this long, so nobody can hold a
    /// ticker's only round open for good (Codex r2 #8).
    uint64 public constant MAX_ROUND_SECONDS = 30 days;
    uint32 public constant MAX_LP_LOCK_SECONDS = 30 days;
    /// A round nobody has pledged to may be replaced this long after it opened.
    uint64 public constant REPLACE_UNPLEDGED_AFTER = 1 days;
    /// An Open round with less than this share of its target pledged, and no pledge of at least 0.1% of its
    /// target for a day (or since it opened), may be replaced; the old one is cancelled and refunds. A dust
    /// pledge cannot hold a ticker (Codex r3 #1), and a round still gathering pledges is never cancelled
    /// (Codex r4 #2).
    uint16 public constant REPLACE_BELOW_BPS = 1000;

    /// The smallest target a round may have, in USDC (6 decimals). 0 = no minimum (testnet). Set from what
    /// a fill costs the filler (an issuer's fixed cost per mint), not guessed; the owner can change it.
    uint256 public minTarget;

    mapping(address token => Feed) public feedOf;
    mapping(address token => address) public latestRound;
    mapping(address round => uint64) public openedAt;
    mapping(bytes32 keyHash => address) public roundForPool;
    address[] public rounds;

    error NotOwner();
    error NotListed(address token);
    error RoundActive(address round);
    error TokenLive(address round);
    error AlreadyListed(address token);
    error TargetTooSmall(uint256 target, uint256 minTarget);
    error BadRoundTerms();

    event Listed(address indexed token, address source, bytes32 priceId, uint32 maxAge, bool pull);
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

    /// Binds a token to its price feed (source contract, feed id, oldest accepted price). Once, so a live
    /// round's feed can never change under it.
    function list(address token, address source, bytes32 priceId, uint32 maxAge, bool pull) external onlyOwner {
        if (feedOf[token].source != address(0)) revert AlreadyListed(token);
        if (source == address(0) || priceId == bytes32(0) || maxAge == 0) revert NotListed(token);
        feedOf[token] = Feed(source, priceId, maxAge, pull);
        emit Listed(token, source, priceId, maxAge, pull);
    }

    /// Anyone may open a round for a listed token, unless one is still running or one already filled
    /// (the token then has its Summon pool, and the pool key can only be initialized once). A running
    /// round that nobody has pledged to may be replaced a day after it opened.
    function openRound(address token, uint256 target, uint64 deadline, uint16 maxSpreadBps, uint32 lpLockSeconds)
        external
        returns (SummonRound round)
    {
        Feed memory feed = feedOf[token];
        if (feed.source == address(0)) revert NotListed(token);
        if (target < minTarget) revert TargetTooSmall(target, minTarget);
        if (deadline > block.timestamp + MAX_ROUND_SECONDS || lpLockSeconds > MAX_LP_LOCK_SECONDS) revert BadRoundTerms();
        address prev = latestRound[token];
        if (prev != address(0)) {
            SummonRound.State s = SummonRound(prev).state();
            if (s == SummonRound.State.Filled) revert TokenLive(prev);
            bool stale = s == SummonRound.State.Open
                && SummonRound(prev).pledged() * 1e4 < SummonRound(prev).params().target * REPLACE_BELOW_BPS
                && block.timestamp >= _max(openedAt[prev], SummonRound(prev).lastPledgeAt()) + REPLACE_UNPLEDGED_AFTER;
            if (s != SummonRound.State.Expired && !stale) revert RoundActive(prev);
            if (stale) SummonRound(prev).cancel();
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
                maxPythAge: feed.maxAge,
                pull: feed.pull,
                maxConfBps: df.maxConfBps,
                maxJumpBps: df.maxJumpBps,
                cooldownSeconds: df.cooldownSeconds
            })
        );
        latestRound[token] = address(round);
        openedAt[address(round)] = uint64(block.timestamp);
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

    function _max(uint64 a, uint64 b) internal pure returns (uint64) {
        return a > b ? a : b;
    }
}
