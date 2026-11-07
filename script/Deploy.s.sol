// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {SummonFactory} from "../src/SummonFactory.sol";
import {SummonRound} from "../src/SummonRound.sol";
import {SummonHook, ISummonRegistry} from "../src/SummonHook.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {DemoOracleRegistry} from "../src/testnet/DemoOracleRegistry.sol";

/// Deploys Summon on Base Sepolia, except the B20 stock (created with the B20 factory precompile by
/// ts/create-stock.ts, which forge cannot simulate). Then lists that stock against its Pyth feed.
///
///   STOCK_TOKEN=0xb2… PRICE_ID=0x6f9c… forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408; // Uniswap v4, Base Sepolia
    address constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729; // Pyth Core, Base Sepolia
    address constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002; // B20 precompile
    uint160 constant FLAG_MASK = (1 << 14) - 1;
    uint160 constant BEFORE_INITIALIZE = 1 << 13;

    function run() external {
        address stock = vm.envAddress("STOCK_TOKEN");
        bytes32 priceId = vm.envBytes32("PRICE_ID");
        address me = vm.envOr("DEPLOYER", msg.sender);

        bytes memory hookInit = abi.encodePacked(type(SummonHook).creationCode, abi.encode(POOL_MANAGER, me));
        (bytes32 salt, address hookAddr) = mineHookSalt(keccak256(hookInit));

        vm.startBroadcast();
        MarketStateRegistry market = new MarketStateRegistry(me);
        market.setUpdater(me, true);
        DemoOracleRegistry oracle = new DemoOracleRegistry(me);
        oracle.set(stock, 1e18, false);
        TestUSDC usdc = new TestUSDC();
        SummonHook hook = new SummonHook{salt: salt}(POOL_MANAGER, me);
        require(address(hook) == hookAddr, "hook address");
        SummonFactory factory = new SummonFactory(
            me,
            SummonRound.Deps({
                usdc: address(usdc),
                pyth: PYTH,
                policyRegistry: POLICY_REGISTRY,
                marketState: address(market),
                oracleRegistry: address(oracle),
                poolManager: POOL_MANAGER,
                hook: address(hook)
            }),
            SummonFactory.Defaults({
                lpBps: 2000,
                rampSeconds: 1800,
                windowSeconds: 3600,
                maxAuctions: 3,
                maxGuardAge: 300,
                maxPythAge: 60,
                maxConfBps: 50,
                maxJumpBps: 300,
                cooldownSeconds: 3600
            })
        );
        hook.setFactory(ISummonRegistry(address(factory)));
        factory.list(stock, priceId);
        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeAddress(o, "stock", stock);
        vm.serializeBytes32(o, "priceId", priceId);
        vm.serializeAddress(o, "marketState", address(market));
        vm.serializeAddress(o, "oracleRegistry", address(oracle));
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "hook", address(hook));
        vm.serializeAddress(o, "poolManager", POOL_MANAGER);
        vm.serializeAddress(o, "pyth", PYTH);
        string memory json = vm.serializeAddress(o, "factory", address(factory));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("factory", address(factory));
        console2.log("hook", address(hook));
    }

    /// A CREATE2 salt whose hook address has BEFORE_INITIALIZE as its only flag bit.
    function mineHookSalt(bytes32 initHash) public pure returns (bytes32 salt, address addr) {
        for (uint256 i; i < 1_000_000; ++i) {
            salt = bytes32(i);
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initHash)))));
            if (uint160(addr) & FLAG_MASK == BEFORE_INITIALIZE) return (salt, addr);
        }
        revert("no salt");
    }
}
