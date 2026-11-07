// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

interface ISummonRegistry {
    function roundForPool(bytes32 keyHash) external view returns (address);
}

/// @title SummonHook
/// @notice Spec 001 §5.5. Only the round a pool key was registered for may initialize it, so nobody
///         can create a Summon pool first at a bad price. Deployed at an address whose flags are
///         BEFORE_INITIALIZE only.
contract SummonHook {
    address public immutable poolManager;
    address public immutable deployer;
    ISummonRegistry public factory;

    error NotPoolManager();
    error NotDeployer();
    error FactoryAlreadySet();
    error NotTheRound(address sender);

    constructor(address poolManager_, address deployer_) {
        poolManager = poolManager_;
        deployer = deployer_;
    }

    /// One-time wiring; the factory needs the hook's address and the hook needs the factory's.
    function setFactory(ISummonRegistry f) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(factory) != address(0)) revert FactoryAlreadySet();
        factory = f;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view returns (bytes4) {
        if (msg.sender != poolManager) revert NotPoolManager();
        if (address(factory) == address(0) || factory.roundForPool(keccak256(abi.encode(key))) != sender) {
            revert NotTheRound(sender);
        }
        return IHooks.beforeInitialize.selector;
    }
}
