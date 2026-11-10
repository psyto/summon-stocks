// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {SummonFactory} from "../src/SummonFactory.sol";
import {SummonRound} from "../src/SummonRound.sol";
import {SummonHook, ISummonRegistry} from "../src/SummonHook.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {DemoOracleRegistry} from "../src/testnet/DemoOracleRegistry.sol";
import {GuardPriceFeed} from "../src/testnet/GuardPriceFeed.sol";
import {SummonSwap, ISummonPools} from "../src/SummonSwap.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// Deploys Summon on Base Sepolia, except the B20 stock (created with the B20 factory precompile by
/// ts/create-stock.ts, which forge cannot simulate). Then lists that stock against its price feed:
/// PRICE_SOURCE=guard (default; GuardPriceFeed, written by the demo guard) or PRICE_SOURCE=pyth (Pyth
/// Core, which needs Hermes update data and so a Pyth API key).
///
///   STOCK_TOKEN=0xb2… PRICE_ID=0x6f9c… forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408; // Uniswap v4, Base Sepolia
    address constant PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729; // Pyth Core, Base Sepolia
    address constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002; // B20 precompile
    uint160 constant FLAG_MASK = (1 << 14) - 1;
    // SummonHook's flags (§5.5): BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP
    uint160 constant HOOK_FLAGS = (1 << 13) | (1 << 11) | (1 << 7);

    struct Out {
        address stock;
        bytes32 priceId;
        address market;
        address oracle;
        address usdc;
        address guardFeed;
        address hook;
        address factory;
        address swap;
        address source;
    }

    function run() external {
        address me = vm.envOr("DEPLOYER", msg.sender);
        Out memory o;
        o.stock = vm.envAddress("STOCK_TOKEN");
        o.priceId = vm.envBytes32("PRICE_ID");
        bool usePyth = keccak256(bytes(vm.envOr("PRICE_SOURCE", string("guard")))) == keccak256("pyth");
        (bytes32 salt, address hookAddr) =
            mineHookSalt(keccak256(abi.encodePacked(type(SummonHook).creationCode, abi.encode(POOL_MANAGER, me))));

        vm.startBroadcast();
        _deployDeps(o, me);
        SummonHook hook = new SummonHook{salt: salt}(POOL_MANAGER, me);
        require(address(hook) == hookAddr, "hook address");
        o.hook = address(hook);
        o.factory = address(_deployFactory(o, me));
        hook.setFactory(ISummonRegistry(o.factory));
        o.swap = address(new SummonSwap(IPoolManager(POOL_MANAGER), ISummonPools(o.factory)));
        o.source = usePyth ? PYTH : o.guardFeed;
        SummonFactory(o.factory).list(o.stock, o.source, o.priceId);
        vm.stopBroadcast();

        _write(o);
        console2.log("factory", o.factory);
        console2.log("hook", o.hook);
        console2.log("price source", usePyth ? "pyth" : "guard");
    }

    function _deployDeps(Out memory o, address me) internal {
        MarketStateRegistry market = new MarketStateRegistry(me);
        market.setUpdater(me, true);
        DemoOracleRegistry oracle = new DemoOracleRegistry(me);
        oracle.set(o.stock, 1e18, false);
        GuardPriceFeed guardFeed = new GuardPriceFeed(me);
        guardFeed.setUpdater(me, true);
        o.market = address(market);
        o.oracle = address(oracle);
        o.usdc = address(new TestUSDC());
        o.guardFeed = address(guardFeed);
    }

    function _deployFactory(Out memory o, address me) internal returns (SummonFactory) {
        return new SummonFactory(
            me,
            SummonRound.Deps({
                usdc: o.usdc,
                policyRegistry: POLICY_REGISTRY,
                marketState: o.market,
                oracleRegistry: o.oracle,
                poolManager: POOL_MANAGER,
                hook: o.hook
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
    }

    function _write(Out memory o) internal {
        string memory k = "deploy";
        vm.serializeAddress(k, "stock", o.stock);
        vm.serializeBytes32(k, "priceId", o.priceId);
        vm.serializeAddress(k, "marketState", o.market);
        vm.serializeAddress(k, "oracleRegistry", o.oracle);
        vm.serializeAddress(k, "usdc", o.usdc);
        vm.serializeAddress(k, "hook", o.hook);
        vm.serializeAddress(k, "poolManager", POOL_MANAGER);
        vm.serializeAddress(k, "pyth", PYTH);
        vm.serializeAddress(k, "guardFeed", o.guardFeed);
        vm.serializeAddress(k, "priceSource", o.source);
        vm.serializeAddress(k, "swap", o.swap);
        string memory json = vm.serializeAddress(k, "factory", o.factory);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }

    /// A CREATE2 salt whose hook address carries exactly SummonHook's flag bits.
    function mineHookSalt(bytes32 initHash) public pure returns (bytes32 salt, address addr) {
        for (uint256 i; i < 1_000_000; ++i) {
            salt = bytes32(i);
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initHash)))));
            if (uint160(addr) & FLAG_MASK == HOOK_FLAGS) return (salt, addr);
        }
        revert("no salt");
    }
}
