You are Codex, reviewing work written by Claude (a different model). Do not defer to it; your job is to break it.

Repo: ~/src/summon-stocks (Base Sepolia only, hackathon entry, solo builder, submission 2026-12-05).
Read docs/specs/001-summon.md (r3) first, then:
- contracts: src/SummonRound.sol, src/SummonFactory.sol, src/SummonHook.sol, src/SummonPool.sol, src/SummonPrice.sol,
  src/SummonSwap.sol,
  src/testnet/GuardPriceFeed.sol, src/testnet/DemoOracleRegistry.sol, src/testnet/TestUSDC.sol
- tests: test/SummonRound.t.sol, test/SummonPrice.t.sol, test/mocks/Mocks.sol
- parts it depends on: lib/hl-price-guard (PythRef.readFresh/updateAndReadFresh, JumpLatch), lib/market-state
  (MarketStateRegistry, MarketStateCheck.requireOpen), lib/v4-core v4.0.0, lib/base-std v1.1.0 (B20 interfaces)
- off-chain: ts/guard.ts (writes halts and, for guard pricing, a Nasdaq quote), ts/e2e.ts, web/worker/index.ts
  (stores EIP-712 intents, the /api/demand export, US block, per-network limits), web/src/round.ts (what the
  round page tells users), web/src/board.ts (opens a round once a stock's intents reach $250)

Facts already checked on Base Sepolia (do not re-derive): the demo stock is a real B20 Asset created with
createB20; multiplier 1e18, effectiveAt 0, all three transfer policies are id 0 (always allow). Deployed
addresses are in deployments/84532.json. `forge test` passes 41 tests; `cd web && npm run test:worker` passes 8 (checked 2026-11-08).

Where Claude thinks it is weakest (start here):
1. Price manipulation by the filler: the filler supplies the price update (Pyth) or the guard posts it
   (GuardPriceFeed). Within maxPythAge (60 s) and maxConfBps (50 bp), can a filler choose a favorable price?
   Is the jump latch anchored at startAuction enough, given that the anchor is set from the same source?
2. fill(): token pulled from the filler, USDC paid, then the pool seeded inside unlock. Check F1/F2,
   rounding, the seed amounts versus what modifyLiquidity actually takes, and the dust left to backers.
   Can backerTokens exceed what the round holds?
3. SummonHook + SummonFactory: the pool key is registered at openRound. Can anyone else initialize that key,
   or initialize a key that collides? What happens to a second round for the same token after an expiry?
4. Lifecycle: _sync() and the time transitions (deadline, window, maxAuctions). Any path where pledges are
   stuck, double-claimed, or refunded after a fill? claim()/claimLP() under a policy that changes after fill.
5. unwindLP(): one-time removal and pro-rata claims, fee accounting, the case where no one unwinds.
6. Worker: can the intent board be inflated, or a round opened from it early, despite the limits (KV eventual consistency on the summary,
   replaying a signature, expiry handling)? Is the US block bypassable through any route?
7. SummonSwap: exact-input swaps on a summoned pool. Slippage bounds, who can call it, and whether it can
   touch a pool that no round created.

Also flag anything in the README or the round page that claims more than the code does.

Output: numbered findings, each with severity (blocker/major/minor), file:line, a concrete failure scenario
(inputs and steps), and a proposed fix. Last line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES".
Do not edit files.
