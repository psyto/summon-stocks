# 001: Summon — backers bring a stock onto Base

Status: draft r1 (Claude). For Base "Stocksmaxxing" (submission 2026-12-05). Testnet only.

## 1. Why

Coinbase has registered 298 B20 tokenized stocks on Base. On 2026-11-07, 227 had a total supply of 0
(`/v1/tokenized-stocks/total-supply`). About 15 carry nearly all Base volume. DJT, AMC, GME, RIVN and RDDT
are minted but have no pool at all. The stocks with the most devoted retail communities are the ones that
cannot be bought onchain.

Summon lets a stock's backers call it onto Base. Backers commit USDC to a ticker. When the target is reached,
anyone who holds the stock token fills the round at the reference price plus a capped spread. Part of the
round seeds a pool whose LP position the backers own together. A public board ranks which ticker comes next.

Issuers lack a demand signal for which of the 227 tickers to mint first. Summon gives them one.

## 2. Scope

In scope (all contracts on Base Sepolia):
- `SummonRound`: one funding round per ticker, with pledge, fill, LP seeding and claims.
- `SummonFactory`: opens rounds and keeps the list of rounds.
- Fill conditions: the market is open and not halted, the reference price is fresh, there is no
  corporate-action window, and the token can be transferred to the round and to backers.
- A real B20 Asset on Base Sepolia created through `createB20`, used as the demo stock. Section 7 has the
  fallback.
- An intent board: backers sign non-binding EIP-712 intents ("I would put $X into TICKER"). The signatures
  are stored off-chain. No funds move.
- Read-only mainnet data in the UI: the B20 list, supplies, NAV, Chainlink feeds and Nasdaq halts.

Non-goals:
- No mainnet contracts, no custody of real funds, no real issuer or authorized participant.
- No KYC or eligibility checks. The UI shows a Reg S notice and blocks US IPs. B20 transfer policies are
  respected onchain (section 5.4).
- No price feed for tickers that do not have one. A round can open only for a token with a configured feed.
- No governance token. Summon has no token of its own.

## 3. Actors

- Summoner: opens a round for a ticker (anyone).
- Backer: pledges test USDC into a round, and can withdraw while the round is Open.
- Filler: holds the stock token and delivers it at the auction price. Any address can fill. In the demo the
  filler is our own script playing the issuer or authorized participant (the earlier project `MockItnIssuer` flow).
- Guard: the off-chain updater that writes halt and session state into the earlier project's `MarketStateRegistry`.

## 4. Round lifecycle

```
Open ──(pledged >= target)──> Auction ──fill()──> Filled ──claim()──> (per backer)
  │                              │
  └──(now > deadline)──> Expired <──(auction window ends, no fill)
                           └── refund() per backer
```

- Open: `pledge(amount)` and `withdraw(amount)` are allowed. When a pledge brings the total to `target` or
  more, the round moves to Auction and records `auctionStart`. After that point, pledges and withdrawals
  are frozen.
- Auction: a Dutch auction on the spread. The allowed spread rises linearly from 0 at `auctionStart` to
  `maxSpreadBps` at `auctionStart + auctionWindow`. The first valid `fill()` takes the round at the current
  spread. Time spent while the fill conditions fail still counts toward the window, so a closed market can
  run the auction out and cause expiry. `auctionWindow` defaults to 2 trading hours, and the round should be
  opened so that its auction falls in a session.
- Expired: reached when there is no fill by `deadline`, or by `auctionStart + auctionWindow`. Each backer
  can call `refund()`.
- Filled: terminal for the auction. Backers `claim()`.

## 5. Mechanics

### 5.1 Price
- `feedPrice` comes from Chainlink `latestRoundData()` (8 decimals). Base documents the feed as
  **total-return: it already equals underlying price × multiplier, per token unit**. Summon must not apply
  the multiplier again. Fill price per raw token unit = `feedPrice × (1 + spreadBps/1e4)`, converted to
  USDC (6 decimals) and to the token's decimals. Rounding always goes against the filler.
- Invariant P1: the USDC paid for N raw token units equals N × the per-unit fill price, rounded down. No
  path multiplies by `multiplier()`.

### 5.2 Fill conditions (all must hold, checked inside `fill`)
1. The round is in Auction, and `now <= auctionStart + auctionWindow`.
2. Market state: `MarketStateRegistry.stateOf(token)` reports not halted, `updatedAt` is within
   `maxGuardAge` (fail closed), and `now >= resumeAfter`. This uses the earlier project's contract as is.
3. Feed fresh: `answer > 0`, `updatedAt <= now`, and `now - updatedAt <= maxFeedAge` (default 15 min,
   session only). Base documents the feed as freezing off-hours, so it holds stale values on nights and
   weekends; the age check is what rejects them.
4. Registry pause: the Coinbase-style oracle registry pause flag for the token is false. In the demo this is
   a mock registry with the same `(multiplier, paused)` read.
5. Multiplier window: there is no scheduled ERC-8056 update whose `effectiveAt` falls within
   `[now - cooldown, now + cooldown]`. This follows the earlier project `checkMarketOpen`'s multiplier-window rule.
6. Token not paused for transfers. The B20 pause vectors are checked, and an unreadable result counts as
   paused.
7. Policy: `isAuthorized` is true for the round contract as receiver and sender. Claims check backers at
   claim time (5.4).
8. Jump guard: if the feed moved more than `maxJumpBps` between its previous round and its latest round, no
   fill is allowed until the next update. This is to be taken from hl-price-guard's jump latch if that latch
   is generic enough (section 8).

### 5.3 What a fill moves
Let `P` be the total pledged USDC and `lpBps` the share that seeds the pool (default 2000).
- The filler delivers `Q = (P × (1 − lpBps/1e4)) / price + Qlp` raw tokens, where
  `Qlp = (P × lpBps/1e4) / price` is paired with the LP USDC.
- The filler receives `P − P × lpBps/1e4` USDC. The LP USDC stays with the round and seeds the pool.
- The round creates or joins a Uniswap v4 pool (stock/USDC, full range, Base Sepolia PoolManager) with
  `Qlp` tokens and `P × lpBps/1e4` USDC. The position is held by the round contract.
- Backers get `(P − LP USDC)/price` tokens pro rata to their pledges, plus pro-rata claims on the LP
  position and its fees.
- Invariant F1: after `fill`, the round holds exactly the tokens owed to backers plus the LP position. The
  round's USDC balance equals 0 plus dust, and dust goes to the last claimer or is swept to backers.

### 5.4 Claims and policy
- `claim()` transfers the backer's tokens. If the B20 receiver policy rejects the backer, the claim
  reverts with `NotAuthorized` and the tokens stay claimable. The round never seizes tokens or redirects
  them.
- LP: `claimFees()` pays pro-rata fees at any time. `exitLP()` is allowed after `lpLock` (default 30 days),
  and each backer burns their share of liquidity.

### 5.5 Pool price at seeding
The pool is seeded at the fill price. If a pool already exists, the round adds liquidity only when the pool
price is within `maxSeedDeviationBps` of the fill price. Otherwise it keeps the LP USDC and tokens as plain
balances and backers claim them pro rata. Summon does not arbitrage the existing pool.

## 6. Intent board (off-chain, no funds)
- EIP-712 `Intent{ticker, usd, expiry, nonce}`, signed with the user's wallet (Base Account). Stored in a
  Worker together with the signer. The board shows the number of unique signers and the total USD per
  ticker.
- An intent is labelled non-binding everywhere. Sybil resistance is out of scope; the board shows the
  number of unique addresses and does not claim they are people.
- Tickers on the board: the 227 unminted, plus minted tickers with no pool, from the live API.

## 7. B20 on Base Sepolia
- The factory precompile `0xB20f…0000` and the registries `0x8453…0001/0002` respond on Base Sepolia
  (checked 2026-11-07). Step 1 of implementation: confirm that the ASSET variant is activated on Sepolia, then
  create a demo stock token with multiplier, pause and policy roles.
- If ASSET is not activated: a mock that implements the subset of `IB20Asset` Summon reads (`multiplier`,
  `uiMultiplier`, pending update `effectiveAt`, pause vectors, `isAuthorized` through a mock policy
  registry). It is deployed as a normal contract and labelled a mock in the UI.
- Foundry unit tests always use the mock, because anvil has no B20 precompiles. One fork e2e runs against
  Base Sepolia when ASSET is live.

## 8. Own parts used (dogfooding)
- the earlier project (an earlier private project): `MarketStateRegistry`, `ts/guard.ts`
  (`parseNasdaqFeed`, `inRegularSession`, `marketStateFor`), and the multiplier-window rule in
  `checkMarketOpen`. Installed as a git dependency at a pinned rev, not by path or by copying.
- hl-price-guard (`fabrknt/hl-price-guard`, public): use its jump latch for 5.2(8) if it accepts a
  Chainlink-shaped price. If it is HyperEVM-specific, record why in an issue on that repo and implement the
  minimal check here, linking the issue.

## 9. Acceptance criteria
- A1: The full flow on Base Sepolia — open → pledges from 3 wallets → Auction → fill at the current spread
  → claims → LP fees claimable — is scripted, and each step's tx hash is printed.
- A2: Each fill condition in 5.2 has a test where only that condition fails and `fill` reverts with its own
  error.
- A3: P1 and F1 hold under fuzzing (random pledges, decimals 6/8/18, prices, spreads, multipliers ≠ 1).
- A4: Changing the multiplier mid-test does not change the fill price (it is total-return). A test that
  applies the multiplier on top fails, showing the check is real.
- A5: Withdrawing during Open, and attempting to withdraw during Auction (reverts), are both covered.
- A6: Expiry by deadline and by auction window, with full refunds summing to P.
- A7: The UI shows the live mainnet counts (registered, minted, unminted, with no pool) from the API, and the
  number matches a script run at the same time.
- A8: The README quickstart works from a fresh clone.

## 10. Milestones
- 11-13: spec approved (Codex), repo skeleton, B20 Sepolia check (step 1 of section 7).
- 11-20: contracts + tests (A2–A6).
- 11-27: Sepolia e2e (A1) + guard on Sepolia.
- 12-02: UI (board, round page, mainnet counts) + intent signing.
- 12-05: video, X post (@buildonbase), submission form.

## 11. Open questions / weakest points (reviewers: start here)
1. Dutch auction on the spread: the first filler can wait for the maximum spread. Is a linear ramp with
   first-fill-wins right, or should the window be shorter and the maximum lower? Can a filler grief by never
   filling?
2. Pledge withdrawal during Open lets a whale push a round into Auction, which freezes everyone. Pledges
   cannot be withdrawn after that, and a whale cannot withdraw either. Is that enough?
3. LP seeding into an existing pool with a manipulated price (5.5): is the deviation check enough, given a
   spot read on the same block?
4. The fill conditions depend on our own guard (`MarketStateRegistry` updater). A stopped guard fails
   closed, but a malicious guard could open a halted market. For the testnet demo the guard is our key.
   State this in the README.
5. Rounding and dust across 6/8/18 decimals and pro-rata claims.
