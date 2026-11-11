# 001: Summon — backers bring a stock onto Base

Status: draft r5 (Claude, 2026-11-11): r4 after Codex reviews r1-r3 (docs/reviews): a pull price taken
at a set time (5.1), round terms and replacement (2a), and an issuer pause that stops swaps (5.5); target
bounds and the auction-start cutoff after r6 (2a). r4
(2026-11-08) was r3 plus a pool that knows the stock's market (5.5, 5.5a) and US session edges (5.2 item 9). r3 was r2 answering docs/reviews/001-spec-r1-claude.md, plus two decisions
made while implementing it (section 2a). Prepared for Base "Stocksmaxxing",
track Programmable Stock Markets, submission 2026-12-05. Testnet only.

## 1. Why

Coinbase has registered 298 B20 tokenized stocks on Base. On 2026-11-07, 227 had a total supply of 0
(`/v1/tokenized-stocks/total-supply`). About 15 carry nearly all Base volume. DJT, AMC, GME, RIVN and RDDT
are minted but have no pool at all. Chainlink feeds exist only for 10 liquid tickers, and the API's
`nav_price` is null for GMEc and DJTc. Pyth publishes US equity prices for 213 of the 298 tickers, including
154 of the 227 unminted ones (Hermes `price_feeds?asset_type=equity`, 1,277 equity feeds, checked
2026-11-07).

Summon lets a stock's backers call it onto Base. Backers commit USDC to a ticker. When the target is reached
and the market is open, anyone who holds the stock token fills the round at the reference price plus a
small capped spread. Part of the round seeds a pool that the backers own together. A public board ranks
which ticker comes next.

Issuers lack a demand signal for which tickers to mint first. Summon gives them one.

## 2. Scope

In scope (all contracts on Base Sepolia):
- `SummonRound`: one round per ticker, covering pledge, auction, fill, LP seed, claims, refunds and LP
  unwind.
- `SummonFactory`: opens rounds and keeps the list of rounds.
- `SummonHook`: a Uniswap v4 hook whose only job is to let the round initialize its own pool.
- Fill conditions (5.2).
- A real B20 Asset on Base Sepolia created through `createB20`, if the ASSET variant is active there.
  Section 7 has the fallback.
- An intent board: backers sign non-binding EIP-712 intents. They are stored off-chain and no funds move.
- Read-only mainnet data in the UI: the B20 list, supplies, which tickers have a Pyth feed, and which have a
  pool.

Non-goals:
- No mainnet contracts, no real funds, and no real issuer or authorized participant.
- No KYC. The UI blocks US IPs and shows a Reg S notice. B20 transfer policies are respected onchain
  (5.4).
- No round for a ticker without a Pyth US equity feed. The board shows such tickers as "needs a price
  feed".
- No Summon token.
- No fee claims at any time. There is one locked LP position per round, unwound once (5.6).

## 2a. Decisions made during implementation (r3)
- **The owner binds each token to its Pyth feed, once** (`SummonFactory.list(token, priceId)`). In r2 the
  summoner chose the feed id, so anyone could open a GME round priced off another stock's feed, and a
  filler would then deliver GME at that other stock's price. Summoners open rounds only for listed tokens.
- **The price source is per listing** (`list(token, source, priceId, maxAge, pull)`): Pyth Core (pull), or the testnet-only
  `GuardPriceFeed` (Pyth's read interface, written by the guard). Hermes needs an API key since
  2026-08-26, and the onchain GME price on Base Sepolia was last pushed in April 2025, so the testnet demo
  defaults to the guard feed. Both sources go through the same 5.1/5.2 checks. The guard's price is the
  HIP-3 oracle price on Hyperliquid (public chain state, no key) since 2026-11-09; before that it read
  Nasdaq.com's quote endpoint, whose terms forbid automated capture. It is demo data: a HIP-3 deployer
  sets it.
- **Round terms are bounded, and a stalled round can be replaced** (r5, Codex r2 #8, r3 #1). A round lasts
  at most 30 days and locks its LP at most 30 days. An Open round at least a day old that is **behind pace**
  may be replaced by a new `openRound` (Codex r3 #1, r4 #2, r5 #1). Behind pace: less than half the pledges
  that a steady climb to the target by the deadline would have by now. The factory cancels the old round in
  the same transaction (it becomes Expired, so every pledge in it is refundable and no new pledge can land
  in it). A round on pace is never cancelled, however small its pledges. To hold a ticker, a squatter must
  keep a growing share of the target locked (half of it by the deadline), and at the target the round is
  Funded, where anyone may start its auctions; after three that nobody fills it is Expired. A squatter's
  reachable target can simply be filled by other backers. On testnet tUSDC is free to mint, so none of this
  costs a griefer money there; on mainnet it is real USDC, and the minimum target applies.
- **Every target lies between 10 and 10^9 USDC** (r5, Codex r6 #1), whatever the owner's minimum says. The
  cap keeps the pace check from overflowing, which would make a round impossible to replace. The pool's seed
  must also be at least 10^4 raw token units (Codex r7 #2), so rounding moves its price by at most 1 bp; a
  target too small for the token's decimals and price cannot start its auction, and the round expires and
  refunds.
- **No auction outlives its round** (r5, Codex r6 #4). `startAuction` is refused unless the whole auction
  window ends by the deadline, and a round's deadline must leave room for one window. A round funded in its
  last hour expires and refunds.
- **A minimum target, set later** (`SummonFactory.setMinTarget`, 0 on testnet). A tiny round cannot cover
  a filler's fixed cost per mint (at most 1% of a $300 round is $3). The number comes from issuers' real
  costs, asked after the hackathon; it is not guessed now. Before money is asked for, signed intents show
  whether a ticker could reach it: a round opens once its intents approach the minimum.
- **Mainnet policies, checked 2026-11-07:** NVDAc, MSTRc and GMEc use policy 5 for every transfer scope.
  Policy 5 has an admin (0xEC0F…2812) and lets an arbitrary address receive, so it acts as a blocklist:
  secondary transfers are open except to blocked addresses. Summon checks these policies before a fill
  and at every claim, so if the issuer tightens them, Summon follows.
- **One Summon pool per token.** A new round may open after an earlier one expired, but not after one
  filled: the pool key can be initialized only once, and r2 has no "join an existing pool" path.

## 3. Actors

- Summoner: anyone; opens a round.
- Backer: pledges test USDC and may withdraw while the round is Open.
- Filler: any address holding the stock token. In the demo this is our script playing the issuer or
  authorized participant.
- Guard: an off-chain updater that writes halt state into `MarketStateRegistry` (8). It is a trusted key,
  and the UI says so on every round page.

## 4. Round lifecycle

```
Open ──(pledged == target)──> Funded ──startAuction()──> Auction ──fill()──> Filled ──unwindLP() after lpLock
  │                             │                          │
  └─(now > deadline)──> Expired <──(deadline passes)───────┴─(now > auctionStart + window, no fill) → back to Funded (max 3 auctions) → Expired
                           └── refund() per backer
```

- Open: `pledge(amount)` accepts at most `target − pledged`; any excess is not taken. `withdraw(amount)`
  is allowed. When `pledged == target`, the round becomes Funded and pledges and withdrawals are frozen.
- Funded → Auction: `startAuction()` is permissionless and succeeds only if every condition in 5.2 holds at
  that moment. It records `auctionStart` and the jump anchor (5.2-8). A round never starts an auction while
  the market is closed.
- Auction: the spread rises linearly from 0 to `maxSpreadBps` over `rampSeconds` (default 1800), then stays
  at `maxSpreadBps` until `auctionStart + window` (default 3600). The first valid `fill()` wins at the current
  spread. If no one fills, the round returns to Funded, at most 3 times, then becomes Expired.
- `maxSpreadBps` is set at open, capped at 100, and shown to every backer before they pledge. It is the
  worst price a backer can pay. A single filler waiting for the maximum is therefore an accepted outcome,
  not an attack.
- Self-fill: a backer who also holds the stock can fill their own round. At worst they earn
  `maxSpreadBps` from the other backers, which the backers accepted when they pledged.
- Expired: reached when `now > deadline` in Open or Funded, or after 3 failed auctions. Each backer calls
  `refund()`, and the refunds sum to `pledged`.

## 5. Mechanics

### 5.1 Reference price and units
- Source: the Pyth pull oracle on Base Sepolia (`0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`, which has
  code). Feed `Equity.US.<TICKER>/USD`, with the id fixed at round open. The filler passes `updateData` into
  `fill()` (paying the Pyth fee). Each listing says how its price is read (r5, Codex r1 #1, r2 #1, r3 #2):
  - **Pull** (Pyth, where the caller supplies the update): a start or fill settles on **the first print
    published at or after `settleTime`**, the start of the previous window of `w` seconds (`w` = 10;
    `settleTime = floor(now / w) × w − w`), through Pyth's `parsePriceFeedUpdatesUnique` and
    hl-price-guard's `PythRef.readFirstAfter`. The block sets the time, so a filler cannot pick a favorable
    print from several; it can only choose when to fill, as in any auction. A transaction built for one
    window lands any time in the next `w` seconds, and the print is at most `2w` old.
  - Choosing the band is choosing when to fill (Codex r4 #1), and it stays allowed: every fill settles on
    the market's price at that time, plus a spread capped at `maxSpreadBps` and shown before anyone pledges,
    and the jump latch refuses a price more than `maxJumpBps` from the start. Fixing one settlement time at
    the start instead would be worse: for the whole window (an hour) the filler would hold an option to
    fill at a known, aging price after the market had moved. A band in which Pyth printed nothing has no
    price; the next band does (equity feeds print several times a second in the session), and the filler
    script tries the next band.
  - **Push** (the testnet `GuardPriceFeed`, written by a trusted guard): the latest stored price, at most
    `maxAge` = 60 s old.
  - A fill also needs a price published after `auctionStart`, so it never settles on the print that
    started the auction.
- Pyth gives the **underlying share price** (`price × 10^expo`). The B20 token is worth underlying ×
  multiplier per whole token (Base docs: "Token Price = Underlying Equity Market Price × Multiplier").
  So, on this path, Summon **must** apply the multiplier, using `multiplier()` (WAD). This is the opposite
  of the Chainlink path, which is already total-return.
- Reference price per whole token, in USD with 18 decimals:
  `ref = price × 10^(18+expo) × multiplier / 1e18`.
- USDC (6 decimals) owed for `qRaw` raw token units at spread `s` bps:
  `usdc = floor(qRaw × ref × (1e4 + s) / (1e4 × 10^dec × 1e12))`, rounded against the filler.
  Raw tokens owed for `u` USDC: `qRaw = ceil(u × 1e4 × 10^dec × 1e12 / (ref × (1e4 + s)))`, rounded
  against the filler (the filler delivers the rounding).
- Confidence: refuse if `conf × 1e4 > price × maxConfBps` (default 50 bps).
- Where the ticker also has a Base Chainlink feed (the 10 liquid ones), it is an optional cross-check:
  refuse if it disagrees by more than `maxCrossBps`, using hl-price-guard's independent-price check (8).
- P1: no code path multiplies a Chainlink price by `multiplier`, and every Pyth price is multiplied exactly
  once.

### 5.2 Fill conditions (checked in both `startAuction` and `fill`)
1. Lifecycle state, per section 4.
2. Market state: `MarketStateRegistry.stateOf(token)` reports not halted, `updatedAt` is within
   `maxGuardAge`, and `now >= resumeAfter`. Fail closed.
3. Price is the listing's (5.1: the first print after `settleTime` for pull, at most 60 s old for push)
   and the confidence bound holds. Pyth equity feeds stop publishing outside
   the session, so this check also enforces session hours.
4. Issuer registry, mainnet shape `getOracleParams(address) → (uint256 multiplier, bool paused)`
   (selector `0xd4197e82`; ABI inferred from the selector name and decoded output, so treat it as
   unverified). On Sepolia this is a mock with the same ABI. Refuse if `paused`, or if its multiplier does
   not equal the token's `multiplier()`.
5. Multiplier window: refuse if the token's `effectiveAt()` is non-zero and within
   `[now − cooldown, now + cooldown]`. Also refuse if `multiplier()` changed since `auctionStart`, because
   an instant `updateMultiplier` clears the pending value.
6. Token not paused: `isPaused(TRANSFER)` is false. A reverting call counts as paused.
7. Policies (read `policyId(scope)` from the token and require `policyExists`; an unknown id counts as a
   refusal):
   - `TRANSFER_SENDER_POLICY`: the filler, the round and the PoolManager.
   - `TRANSFER_RECEIVER_POLICY`: the round and the PoolManager.
   - `TRANSFER_EXECUTOR_POLICY`: the round and the PoolManager.
   - Backers are checked at claim time (5.4).
8. Jump guard: in `fill`, the reference price must be within `maxJumpBps` (default 300) of the anchor
   recorded at `startAuction`. Otherwise `fill` reverts, and the round can only return to Funded when the
   window ends. This uses hl-price-guard's `JumpLatch` with the anchor set by `startAuction`. Re-arming
   happens only through a new `startAuction`.
9. US equity session edges (r4): the guard reports the session closed in the first 15 minutes after the
   open and the last 25 minutes before the close (09:30-09:45 and 15:35-16:00 ET; 12:35-13:00 on early
   closes). Those are the periods when US Limit Up-Limit Down bands are doubled, and quotes and Pyth's
   confidence are widest. Exchange holidays and early closes come from market-state `v0.2.0`.

### 5.3 What a fill moves
Let `P = target`, `U_lp = P × lpBps / 1e4` (default `lpBps` = 2000), and `U_f = P − U_lp`.
- The filler delivers `Q = qRaw(U_f, s)` raw tokens and receives `U_f` USDC.
- From `Q`, the round puts `Qlp = qRaw(U_lp, 0)` tokens and `U_lp` USDC into the pool at the reference price
  `ref`, with no spread. The remaining `Q − Qlp` tokens are owed to backers pro rata.
- F2: the filler's USDC received is ≥ the USDC value of the tokens it delivered at price `ref × (1 + s)`,
  minus at most 1 USDC unit. Equality holds up to rounding, and rounding favors backers.
- F1: after `fill`, the round's token balance is ≥ the tokens owed to backers. Its USDC balance is ≥ 0 and
  ≤ `dustBound`, and the LP position's liquidity is greater than 0. Any dust goes pro rata in `unwindLP`.

### 5.4 Claims
- `claim()` transfers the backer's tokens. If a policy rejects the backer, it reverts with `NotAuthorized`.
  The tokens stay claimable, and the round never redirects them.

### 5.5 Pool: a pool that knows the stock's market (r4, 2026-11-08)
- PoolKey = (token, USDC, dynamic fee, tickSpacing 60, hooks = `SummonHook`). The hook's address carries
  three flags: BEFORE_INITIALIZE, BEFORE_ADD_LIQUIDITY and BEFORE_SWAP.
- `beforeInitialize` and `beforeAddLiquidity`: only the round registered for the key may initialize it or
  add liquidity. Nobody can create the pool first at a bad price, and the position in the pool is the
  backers' alone, which `realign` (5.5a) relies on. Removing liquidity is not gated (only the round has any).
- Seed full range at `ref` (no spread), so the pool does not open overpriced. The round records the
  token's multiplier at the fill as `poolMultiplier`.
- `beforeSwap` reads the same sources as the fill conditions (5.2), and applies these rules in order:
  1. **Corporate action window: no swaps.** The token's `effectiveAt()` is non-zero and within
     `[now − cooldown, now + cooldown]`. The same window as 5.2 item 5.
  2. **Stale multiplier: no swaps.** `multiplier()` differs from `poolMultiplier`. One token is now worth
     a different number of shares, so the pool's price is wrong by that ratio, and the first trader would
     take the difference from the backers. Swaps resume after `realign` (5.5a). The round's own swap
     inside `realign` is the one exception.
  3. **Halted: no swaps.** The market state says halted for any reason other than "session closed"
     (primary halt, bad print, corporate action, manual, issuer paused), or `now < resumeAfter`. When the
     listing exchange stops trading, nobody knows the price. Also the issuer registry (5.2 item 4):
     `paused`, or a multiplier that differs from the token's, stops swaps as it stops fills (r5, Codex r3 #4).
  4. **Closed: a higher fee.** The state says "session closed", or the guard has not confirmed it within
     `maxGuardAge`. Swaps pay `CLOSED_FEE` (1.00%) instead of `OPEN_FEE` (0.30%). Trading on Base does not
     stop at night, but the price cannot be checked against the listing exchange, so the backers, who are
     the LPs, are paid more for that risk.
  5. Otherwise, `OPEN_FEE` (0.30%).

### 5.5a Realign after a corporate action
- `realign()` on the round: anyone may call it once the corporate action window has passed and
  `multiplier()` differs from `poolMultiplier`. In one unlock it removes the whole position, moves the
  now-empty pool's price by `multiplier / poolMultiplier` (a swap with no liquidity moves the price and
  nothing else), and adds the liquidity back at the new price. Then `poolMultiplier` takes the new value.
- No price source is read. The new price is the pool's own price scaled by the issuer's multiplier, so a
  caller cannot choose it.
- What does not fit at the new ratio stays in the round and is added to what backers receive at
  `unwindLP` (5.6).
- Before the LP lock ends this is the only way to resume trading after an action. After the lock,
  backers may also unwind instead.

### 5.6 LP unwind
- One position, held by the round. After `lpLock` (default 7 days in the demo), anyone can call
  `unwindLP()` once. It removes all liquidity, collects fees, and records the tokens and USDC owed per
  backer pro rata. Backers then call `claimLP()`. Policy checks apply as in 5.4.

## 6. Intent board (off-chain, no funds)
- EIP-712 `Intent{ticker, token, usd, expiry, nonce}` (domain version 2, 2026-11-08), signed with the user's
  wallet (Base Account) and stored in a Worker. `token` is the stock's B20 contract address and must match
  the snapshot: Base's docs say to identify a stock by address, because its symbol can change. One intent
  per wallet per token. The board shows unique signers and total USD per ticker, and labels every intent
  non-binding. Sybil resistance is out of scope beyond the limits below (Base Verify, which runs on Base
  Sepolia, is a candidate for showing verified signers separately).
- Rows: every B20 ticker with zero supply or no pool, from the live API. Each row is tagged "Pyth feed" or
  "needs a price feed". A ticker with no feed still takes intents: the demand tells issuers, and feed
  providers, what to add.
- Limits (Worker): 20 intent writes an hour and 5 new wallets a day per network. The demo wallets are
  refused. The site and API are closed to US visitors (HTTP 451).

## 6a. UI rules from the Official Rules (base.org/stocksmaxxing/rules, read 2026-11-07)
- Tickers appear as text only. No company or issuer logos, and no wording that implies a relationship with,
  or endorsement by, Base, Coinbase, a partner, or the listed company (§6).
- Backers "receive a token that tracks the stock". Never "become a shareholder", and never any mention of
  voting or other shareholder rights (§6).
- Demo wallets are labelled as demo wallets everywhere they appear. The intent board never counts our own
  wallets, because manipulating traction metrics is grounds for disqualification (§13).
- US IPs are blocked and a Reg S notice is shown, because projects that enable trading for US users are out
  of scope (FAQ).
- The README and the submission form state what was built during the Quest Period (2026-11-05 to 12-05),
  separately from the pre-existing parts in section 8 (§6).

## 7. B20 on Base Sepolia
- The factory precompile `0xB20f…0000` answers calls on Sepolia, and the registries `0x8453…0001/0002`
  have code (checked 2026-11-07). Step 1: check that the ASSET variant is activated, then create the demo
  stock with operator, pause and policy roles.
- If ASSET is not active: a mock with the same subset of functions (`multiplier`, `effectiveAt`,
  `isPaused`, `policyId`, and a mock policy registry), deployed as a normal contract and labelled a mock in
  the UI.
- Foundry unit tests use the mock, because anvil has no B20 precompiles, even on a fork. The B20 e2e
  broadcasts to live Sepolia.
- Pyth on Sepolia: tests use Pyth's `MockPyth`. The e2e uses the real Sepolia Pyth contract with Hermes
  updates for a real ticker, mapped to the demo token.

## 8. Own parts used (dogfooding)
- market-state (`fabrknt/market-state` v0.3.0, public): `MarketStateRegistry`, `MarketStateCheck.requireOpen`
  (5.2-2), and the TypeScript guard for Nasdaq halts. Extracted from an earlier private project on
  2026-11-07, so that a judge's fresh clone builds. Copying the code into Summon was not an option.
- hl-price-guard (`fabrknt/hl-price-guard` v0.3.2, public): `PythRef.readFresh` (added for Summon), `JumpLatch` with an anchor (5.2-8), and the
  independent-price check (5.1). These are pinned by git rev. If either needs changes to accept Pyth or
  Chainlink shapes, the fix goes into hl-price-guard first.

## 9. Acceptance criteria
- A1: The full flow on Base Sepolia is scripted, and each step prints its tx hash: open → 3 wallets pledge
  to target → startAuction → fill with a Pyth update → claims → (time-warped in a fork test) unwindLP →
  claimLP.
- A2: Each condition in 5.2 has a test where only that condition fails, and the call reverts with its own
  error.
- A3: P1, F1 and F2 hold under fuzzing over decimals 6/8/18, Pyth expo −5…−8, multipliers 0.5–20 WAD and
  spreads 0–100 bps.
- A4: A 10:1 split on the mock (multiplier ×10, mock Pyth price ÷10) leaves the reference price per token
  unchanged. A deliberately wrong version that ignores the multiplier fails this test.
- A5: pledge cap at target; withdraw in Open; withdraw in Funded or Auction reverts.
- A6: Expiry by deadline and after 3 failed auctions. Refunds sum to `pledged`.
- A7: A third party calling `initialize` for the round's PoolKey reverts.
- A8: The UI's live counts (registered, minted, unminted, with a Pyth feed, with no pool) match a script run
  at the same time.
- A9: The README quickstart works from a fresh clone.

## 10. Milestones
- 11-13: spec approved (Codex r1 after 11-10). B20 Sepolia check: done 11-07. Section 8: done 11-07.
- 11-20: contracts and tests (A2–A7). Done 11-07 (39 tests).
- 11-27: Sepolia e2e (A1) and the guard on Sepolia. Deployed and guard checked against it 11-07; e2e needs market
  hours, first run 11-09.
- 12-02: UI (board, round page, live counts) and intent signing. Built 11-07, ahead of plan: the register, round
  pages with live fill conditions, a Worker that verifies intents, the US block and per-network limits.
- 12-04: video, X post (@buildonbase), submission form; 12-05 is spare.

## 11. Open questions / weakest points
1. ~~The Pyth `updateData` is chosen by the filler.~~ Answered in r5: a pull listing settles on the first
   print after a time the block sets (5.1). Open: is a 10 s window right for Base's 2 s blocks and Hermes
   latency?
2. Halts: does Pyth keep publishing during an LULD halt? If it does, the guard is the only defense. How long
   does the guard take to see a halt in the Nasdaq RSS?
3. Policies can change between `fill` and `claim`, which leaves tokens stuck in the round. Is that
   acceptable, given that the tokens remain claimable once the policy allows it?
4. With fee 3000 and a full-range position, the pool is thin for its range. Should the demo use a
   concentrated range around `ref` instead, at the cost of more code?
