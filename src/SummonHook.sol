// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {SummonRound, IB20AssetMin, IOracleParams} from "./SummonRound.sol";
import {SummonPool} from "./SummonPool.sol";

interface ISummonRegistry {
    function roundForPool(bytes32 keyHash) external view returns (address);
}

/// @title SummonHook
/// @notice Spec 001 §5.5: a pool that knows the stock's market. Only the round a pool key was registered
///         for may initialize the pool or add liquidity, so the position is the backers' alone. Swaps stop
///         in a corporate action window, while the token's multiplier differs from the one the pool was
///         priced at (until the round realigns it, §5.5a), and while the listing exchange has the stock
///         halted. While the session is closed, or the guard has gone quiet, swaps pay a higher fee.
///         Deployed at an address whose flags are BEFORE_INITIALIZE, BEFORE_ADD_LIQUIDITY and BEFORE_SWAP.
contract SummonHook {
    address public immutable poolManager;
    address public immutable deployer;
    ISummonRegistry public factory;

    error NotPoolManager();
    error NotDeployer();
    error FactoryAlreadySet();
    error NotTheRound(address sender);
    error CorporateActionWindow(uint256 effectiveAt);
    error StaleMultiplier(uint256 pool, uint256 token);
    error MarketHalted(uint8 reason);
    error IssuerPaused();
    error MultiplierMismatch(uint256 registry, uint256 token);

    constructor(address poolManager_, address deployer_) {
        poolManager = poolManager_;
        deployer = deployer_;
        // The PoolManager calls only the callbacks whose bits are set in this address. Refuse to exist at an
        // address that would skip one of ours (a hook deployed without BEFORE_SWAP would never stop a swap).
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// The callbacks this hook implements; its address must carry exactly these bits.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
    }

    /// One-time wiring; the factory needs the hook's address and the hook needs the factory's.
    function setFactory(ISummonRegistry f) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(factory) != address(0)) revert FactoryAlreadySet();
        factory = f;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view returns (bytes4) {
        _requireRound(sender, key);
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        _requireRound(sender, key);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != poolManager) revert NotPoolManager();
        SummonRound round = SummonRound(_roundOf(key));
        uint24 fee = sender == address(round) ? SummonPool.OPEN_FEE : _swapFee(round);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// The fee a swap pays now (§5.5 rules 1-5); reverts where swaps stop. The round's own swap inside
    /// `realign` skips these rules.
    function _swapFee(SummonRound round) internal view returns (uint24) {
        SummonRound.Params memory p = round.params();
        // 1. corporate action window, the same one the fill conditions use
        uint256 eff = IB20AssetMin(p.token).effectiveAt();
        if (eff != 0 && block.timestamp + p.cooldownSeconds >= eff && block.timestamp <= eff + p.cooldownSeconds) {
            revert CorporateActionWindow(eff);
        }
        // 2. the pool was priced at another multiplier
        uint256 m = IB20AssetMin(p.token).multiplier();
        if (m != round.poolMultiplier()) revert StaleMultiplier(round.poolMultiplier(), m);
        // 2a. the issuer's registry: paused, or disagreeing with the token, stops swaps as it stops fills (Codex r3 #4)
        address reg = round.deps().oracleRegistry;
        if (reg != address(0)) {
            (uint256 rm, bool paused) = IOracleParams(reg).getOracleParams(p.token);
            if (paused) revert IssuerPaused();
            if (rm != m) revert MultiplierMismatch(rm, m);
        }
        // 3. halted, or not yet resumed
        MarketStateRegistry ms = MarketStateRegistry(round.deps().marketState);
        MarketStateRegistry.State memory s = ms.stateOf(p.token);
        if (s.halted && s.reason != ms.REASON_SESSION_CLOSED()) revert MarketHalted(s.reason);
        if (block.timestamp < s.resumeAfter) revert MarketHalted(s.reason);
        // 4. closed, or the guard has not confirmed the state lately
        if (s.halted || uint256(s.updatedAt) + p.maxGuardAge < block.timestamp) return SummonPool.CLOSED_FEE;
        return SummonPool.OPEN_FEE;
    }

    function _roundOf(PoolKey calldata key) internal view returns (address) {
        return address(factory) == address(0) ? address(0) : factory.roundForPool(keccak256(abi.encode(key)));
    }

    function _requireRound(address sender, PoolKey calldata key) internal view {
        if (msg.sender != poolManager) revert NotPoolManager();
        address round = _roundOf(key);
        if (round == address(0) || round != sender) revert NotTheRound(sender);
    }
}
