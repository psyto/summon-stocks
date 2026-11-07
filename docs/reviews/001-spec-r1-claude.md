# 001 spec r1 — independent review (Claude subagent; Codex at usage limit until 2026-11-10)

VERDICT: CHANGES (13 findings). Summary of findings and how r2 answers them:

1. Blocker 5.3: filler delivered P/price tokens but received P·(1−lp) USDC → no rational fill. r2: filler sells (P−U_lp)/price, receives P−U_lp; F2 added.
2. Blocker 5.1: units per raw unit vs whole token. r2: explicit formula with 10^dec, Pyth exponent.
3. Major: Chainlink feeds exist for 10 liquid tickers only; GMEc/DJTc nav_price null. r2: Pyth equity feeds (213/298 B20 tickers, 154/227 unminted; checked 2026-11-07), Chainlink only as cross-check.
4. Major: 15 min maxFeedAge vs 0.5%/24h Chainlink updates; filler free option. r2: Pyth pull price ≤ 60 s old, confidence bound.
5. Major: any wei can trigger auction at a bad time; overshoot; self-fill. r2: pledge capped at target, permissionless startAuction() only when conditions hold, self-fill bounded by maxSpread.
6. Major: single bidder waits to max spread. r2: maxSpread ≤ 100 bps shown at pledge time, 30-min ramp.
7. Major: pool pre-initialization / skim; seeding at fill price. r2: Summon hook beforeInitialize requires the round; seed at reference price.
8. Major: missing TRANSFER_EXECUTOR_POLICY and PoolManager/filler checks. r2: all scopes, policyExists.
9. Minor: registry getOracleParams(address) (selector 0xd4197e82, unverified ABI), isPaused(uint8), instant updateMultiplier clears pending. r2: multiplier mismatch check.
10. Minor: JumpLatch needs anchor + rearm. r2: anchor at auctionStart.
11. Minor: F1 exactness. r2: ≥ with dust bound.
12. Major: private dependency breaks fresh clone; anvil has no B20; LP fee accounting too big. r2: open decision on publishing; live-Sepolia e2e; single locked LP with unwindLP().
13. Minor: guard trust shown in UI. r2: yes.
