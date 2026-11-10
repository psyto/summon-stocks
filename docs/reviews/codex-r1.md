1. **Major — filler selects the auction anchor and a favorable stale Pyth print.**  
   `src/SummonRound.sol:235-245, 249-256, 451`

   Scenario: Pyth published a legitimate $103 print 55 seconds ago during a brief spike; the current market is $100. A filler calls `startAuction(update=$103)`, which sets `latch` to $103, then calls `fill([])` before the 60-second age limit. The filler receives the fixed USDC amount while delivering roughly 2.9% fewer tokens. The 3% jump guard passes because it compares $103 with the filler-chosen $103 anchor. Confidence bounds measure oracle uncertainty, not the price-selection window.

   The GuardPriceFeed route prevents an untrusted filler from posting the price, but the direct Pyth route remains exploitable as described.

   Fix: do not let the same actor choose the anchor and settlement observation. Require a post-auction-start observation after a minimum delay, with an externally scheduled/keeper-provided anchor or a bounded multi-observation median/TWAP. At minimum, require the fill price’s publish time to be after `auctionStart` and disallow immediate same-print filling.

2. **Major — expired intents remain in the board total indefinitely, so they can open a round after expiry.**  
   `web/worker/index.ts:62-64, 105-106, 127-131, 164`  
   `web/src/board.ts:201-247`

   Scenario: sign and submit a valid `$250` GME intent with `expiry = now + 1`. After it expires, `/api/demand` correctly omits it (`web/worker/index.ts:145-147`), but `/api/intents` still returns the persisted `summary` with `$250`. The board consumes that summary and enables “Open a round.”

   There is also no maximum expiry: a client can sign an intent lasting years, contrary to the UI’s 30-day convention.

   Fix: derive the public total from unexpired records, or maintain it transactionally with expiration/cleanup. Enforce a maximum expiry (such as 30 days) server-side. Gate the open affordance on an expiry-filtered total, not the stale summary blob.

3. **Major — intent replacement is replayable and the advertised limits/totals are non-atomic under KV concurrency.**  
   `web/worker/index.ts:72-89, 123-131`

   Scenario A, replay: Alice signs `$250`, nonce 1, then replaces it with `$1`, nonce 2. Anyone retaining the first valid signature can POST nonce 1 again before its expiry; the Worker accepts it and restores `$250`. `nonce` is signed but never compared with a stored high-water mark.

   Scenario B, concurrency: fan out valid signed writes through multiple edge locations simultaneously. Each can read the same old `rl:w` / `rl:a` values before writes propagate, pass the 20-write and five-wallet checks, and overwrite the counter/set. The same read-modify-write pattern on `summary` can leave totals inconsistent with the stored intent records; concurrent replacements for one wallet can make the displayed value correspond to neither current intent deterministically.

   Fix: use a Durable Object keyed by signer/token for monotonic nonce enforcement and a serialized aggregate/limit update. Keep a permanent nonce high-water mark even when an intent expires or is replaced.

4. **Minor — `SummonSwap` is an unrestricted generic v4 router, not a router limited to summoned pools.**  
   `src/SummonSwap.sol:48-80`

   Scenario: deploy or select any initialized v4 pool, construct its `PoolKey`, approve its input ERC-20 to `SummonSwap`, and call `swapExactIn`. There is no factory lookup or round/key validation, so the contract swaps against a pool no Summon round created.

   This does not bypass `SummonHook` protections for actual Summon pools, but it contradicts the contract’s stated scope and lets the public contract be used for unrelated pools.

   Fix: inject the factory/registry and require `roundForPool(key.toId()) != address(0)` before unlocking; alternatively document it explicitly as a general-purpose router.

5. **Minor — the round page overstates what it verifies and quotes the wrong fee outside open conditions.**  
   `web/src/round.ts:136-153, 264, 486, 509-510`  
   `src/SummonRound.sol:257`  
   `src/SummonHook.sol:87-93`

   Scenario: a restricted sender policy allows the round and PoolManager but rejects the intended filler. The page reports “all conditions hold,” yet `fill()` rejects the filler. Separately, when the guard is stale or the session is closed, the hook charges 1.00%, while the page always says “Pool fee 0.3%” and estimates using 0.3%.

   Fix: label the page checks as partial/status checks; simulate or expose a `canFill(filler)` path including the filler policy and auction latch state. Read market state for the trading panel and display the actual dynamic fee.

6. **Minor — the US restriction fails open when Cloudflare country metadata is absent.**  
   `web/worker/index.ts:157-160`

   Scenario: any request presented to the Worker without `request.cf.country` skips the block and can use both page and APIs. The handler’s own direct test shape demonstrates that country is optional. This is distinct from ordinary VPN evasion: the code explicitly permits unknown geography.

   Fix: in production, deny when country is missing or blocked, while retaining the explicit local-development override.

7. **Minor — README deployment/status language is internally stale for this branch.**  
   `README.md:50, 53-57, 68`

   The README calls the spec “r3” twice and presents the Base Sepolia deployment as done alongside a stock-aware implementation it separately says is “not yet deployed.” The listed addresses are the older deployment, not this branch’s contracts. A user can reasonably infer that the live contracts enforce the new hook/realign behavior.

   Fix: label `deployments/84532.json` and all listed addresses as the previous deployment, state that this branch has no deployment, and update references to r4.

VERDICT: CHANGES