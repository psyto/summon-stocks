# Summon

**Backers bring a stock onto Base.**

Coinbase has registered 298 tokenized stocks (B20) on Base. 227 of them have never been minted, and some
that were minted (DJT, AMC, GME) have no pool to trade in.

Summon is a primary-market primitive for tokenized stocks. Committed demand becomes a fill and a pool only
when the stock's market conditions hold onchain. The round contract checks them at every auction start and
fill, caps the price, refunds if nothing fills, and is the only thing that can create the stock's pool. It
reads its market data from registries and price feeds. On testnet, the guard key writes those. A stock's
backers call it onchain like this:

1. Backers commit USDC to a ticker, up to a target.
2. When the target is reached and the market is open, anyone holding the stock token fills the round at a
   live reference price, through a capped spread auction (at most 1%, shown before anyone commits). The
   price comes from Pyth. On testnet it can instead come from a quote the guard posts (see "Price source").
3. Part of the round seeds a Uniswap v4 pool. The pool can only be created by the round, and the backers
   own the LP position together.
4. A public board ranks which ticker comes next. It uses signed, non-binding intents, and no funds move.

A round fills only when every condition below holds:
- the market is open, outside the first 15 and last 25 minutes of the session, and the stock is not halted;
- the price is fresh (on a Pyth listing, the first print after a time the block sets; a guard price, under
  60 s old), its confidence interval is narrow, and it has not jumped since the auction started;
- no corporate action is pending, i.e. no multiplier change near the fill;
- neither the token nor its issuer's registry is paused;
- every transfer policy allows the transfer.

After the fill, the pool keeps knowing the stock's market: its hook stops swaps while the stock is halted,
around a corporate action, or while the issuer pauses it, and charges 1.00% instead of 0.30% while the US
session is closed.

## Why it matters

- **For issuers:** 227 registered stocks have no supply. A funded Summon round is a demand signal any
  issuer can read: these backers have committed this much USDC to this ticker, and they are waiting for a
  fill.
- **For Base:** stocks reach Base in order of demand. Each one arrives with a pool, and its backers are
  the LPs.
- **For launchpads and apps:** a stock with no pool cannot be paired, routed or lent against. Once a stock
  is summoned, any launchpad can pair against it. BaseStonk's public pair list, for example, has 357 stock
  pairs on Base, and 279 of them show no liquidity, including AMCc, RIVNc and SOFIc (read 2026-11-07 from
  api.basestonk.io). A coin paired with one of those has no pool to route through.
- **For backers:** the worst price is shown before you commit (at most 1% over the reference). If the
  round does not fill, every pledge is refunded.

Built for Base's [Stocks Maxxing](https://www.base.org/stocksmaxxing) season (Programmable Stock Markets
track). **Testnet only (Base Sepolia).** Mainnet data is only read and shown.

## Status

| Part | State |
|---|---|
| Spec ([docs/specs/001-summon.md](docs/specs/001-summon.md)) | r5. Reviewed by Codex (a different model) over eight rounds of spec and code on 2026-11-10 and 11-11, every finding fixed or answered, ending in **APPROVE** at [r8](docs/reviews/codex-r8.md). Each round's findings and what changed are in [docs/reviews](docs/reviews) ([what changed, r1-r8](docs/reviews/codex-r1-response.md)), after one independent review of r1 |
| Price math (`src/SummonPrice.sol`, spec 5.1) | done, with tests: split invariance, dividend multiplier, fuzzed rounding |
| Round, factory, pool hook, swap (`src/SummonRound.sol`, `SummonFactory.sol`, `SummonHook.sol`, `SummonSwap.sol`) | done, 51 tests: each fill condition failing alone, pledge cap, target bounds (10 to 10^9 USDC), a pool seed of at least 10^4 token units, no auction past the deadline, withdraw rules, expiry and refunds, claims under transfer policies, LP unwind, pool initialization and liquidity restricted to the round, a fill's price published after the auction started, on a Pyth listing the first print after a time the block sets, round terms of at most 30 days with a round behind pace replaceable (and cancelled) after a day, swaps stopped while the issuer pauses, the router trading only Summon pools, the guard price feed, trading the summoned pool, and the pool that knows the stock's market (below). Removing any of 8 fill checks, or any of the hook's 6 rules, makes a test fail |
| Stock-aware pool (`SummonHook`, `SummonRound.realign`, spec 5.5 and 5.5a, r4) | built 2026-11-08, deployed 2026-11-11, **first trade 2026-11-11 (ET)**: alice bought sGME with 1 tUSDC in the summoned pool and the hook charged 0.30%, the open-session fee ([swap](https://sepolia.basescan.org/tx/0x973b9bcb0b1f11fdf94de03e9219c4c6e1fc6fe98e535c7ff46179a193c510cd), `npm run swap`); after the close it charged 1.00% ([swap](https://sepolia.basescan.org/tx/0x524cf5d54318c305b6e4d14bf354647f82c2bc16b8a76b3e45e8afd539b8e946)). The rules: no swaps in a corporate action window, while the multiplier differs from the one the pool was priced at, or while the listing exchange has the stock halted; a 1.00% fee instead of 0.30% while the session is closed or the guard is quiet; after a split or a dividend in shares, anyone can `realign` the backers' pool to the new multiplier, so the first trader cannot take the difference. No fills in the first 15 and last 25 minutes of the session, while US LULD bands are doubled (market-state `core-hours`). Holidays and 13:00 early closes from market-state `v0.2.0`; from `v0.4.0` a session name it does not know reads closed |
| Base Sepolia deployment | **redeployed 2026-11-11 with the stock-aware pool** (Codex r8 approved): factory, hook, swap router, registries, and the five B20 demo stocks listed again (see below). Rounds on it: sGME filled 11-11, then went through a 2:1 split, `realign` and the LP unwind (11-12); sAMC's first round expired and was refunded, and a second was opened and pledged to by a smart wallet with no ETH (sponsored, 11-12); sRDDT, sSOFI and sRIVN are funded and wait for market hours (sRDDT for the demo video) |
| Guard (`ts/guard.ts`) | done: Nasdaq Trader halts (once a minute) and, for guard pricing, the HIP-3 oracle price from Hyperliquid's chain. At the close it records each stock as closed once, then writes nothing until the open. It refuses to start if the installed market-state does not read a weekend and the first 15 minutes as closed (a stale v0.2.0 build once read the session as always open, so swaps after the close paid 0.30%). `npm run guard -- --quote GME` prints the price it would post and writes nothing |
| End-to-end fill on Base Sepolia (`ts/e2e.ts`) | **first fill done 2026-11-10 (ET), sGME**: three demo backers pledged 300 tUSDC, the auction started, and the demo filler filled at a $25.115 reference (the HIP-3 oracle price the guard posted), 6 bp under it; the Uniswap v4 pool was seeded and every backer claimed. [pledge](https://sepolia.basescan.org/tx/0x3dbe7c7ad11fdd223ddeab48fbc05393fa85a334a9a2b7ed7054433b7cd7a60c) · [auction start](https://sepolia.basescan.org/tx/0x4b5831f2ca5fc62b8695315ca29670eb433421307826bad32aef927df572bb9a) · [fill](https://sepolia.basescan.org/tx/0xb71b8eb7f4cf16fd1bb060b11247b29741a0caf7151036d79965f09497ffb9eb) · [claim](https://sepolia.basescan.org/tx/0xda9dddb16b677e784f2d4bd6868c5e01fefbd6b699f63f7cc8d36d9e75b3b5dc). **Second fill 2026-11-11 (ET), on the redeployed contracts**: sGME again, at a $25.445 reference, 6 bp under it ([open](https://sepolia.basescan.org/tx/0x6f720a4b1dcc759878dcdcdd3e38674a4757bcaa4be5a94abe04fa2d9737f14f) · [auction start](https://sepolia.basescan.org/tx/0x0f3abf7c6f71df87c76b856317ea030481742736ba3772a5ea1d80c3fc745206) · [fill](https://sepolia.basescan.org/tx/0xf46f8fa76f4306ab0bd1eae738b26c4d5e13cc65b9f44ef65ce9990602c52e9a) · [claim](https://sepolia.basescan.org/tx/0xa03085d3b475d0f69be5a66fb3b4e1e99303fbf2f1e102f61f5a8db875196f94)). It picks up the stock's open round wherever it stands, so pledges made from the web page count. On a Pyth listing it moves to a later price band only when Pyth printed nothing in the one it tried. Weekdays 09:45–15:35 ET |
| Web (`web/`) | built 2026-11-07, round page redone 2026-11-12 (one screen: a dial that fills with pledges, runs with the auction's spread and shows the pool's fee; quotes from the chain, the backer's position, every transaction simulated first; a wallet picker and Base Account; every intent signature checkable in the browser): the register of all 298 stocks; live round pages; signed intents, with a round opening from the register once a demo stock's intents reach $250; trading a summoned pool; a demand export issuers can verify; the US block and per-network limits (27 Worker tests, intents in one Durable Object so nonce checks and limits are exact, with totals kept per token (named by the current snapshot) and live intents and nonces capped: totals count only unexpired intents, a replay sent with its replacement loses, expired intents are swept, the demand export is paged, an intent lasts at most 31 days, an older signature cannot restore a replaced intent, a nonce far ahead is refused, and a request with no country is refused). Runs locally. Not public yet: the code review is done, and the author decides when |
| Keeper (`ts/keeper.ts`) | built 2026-11-12: on **summoning days** (`ts/schedule.ts`: Tuesdays and Thursdays, 10:00 New York time; the page shows the next one on every funded round) starts an auction once the round accepts it, fills at a set spread (default 25 bp) or in the last 2 minutes, ends an auction nobody filled, and with `UNWIND=1` unwinds after the lock. Each call is simulated first, so a waiting round says why (`MarketHalted(3)` after hours). A reference for "who fills": any holder can run it |
| Telegram alerts (`web/worker/alerts.ts`) | built 2026-11-12: follow a demo stock with the bot, hear when its round changes and 15 minutes before its summoning. Checked against a local Worker reading Base Sepolia (`/start RDDT` answered with the funded sRDDT round) and in the Worker tests with a stand-in Telegram. Off until a bot token is set: the bot is not created yet |
| Gas sponsorship (`web/worker/paymaster.ts`) | built 2026-11-12: Base Account's transactions are sponsored through the CDP Paymaster, so a visitor needs no testnet ETH, and an order's steps go as one batch. The proxy sponsors only calls to Summon's contracts or the factory's rounds. Checked on Base Sepolia with a Coinbase Smart Wallet holding 0 ETH: it opened an sAMC round and pledged in one batch ([open](https://sepolia.basescan.org/tx/0xe33e3be943e08100020a980022382d7e3d772c91ff1c0c60ee56feca35e754d2), [pledge](https://sepolia.basescan.org/tx/0x434eb7b3b4ef76bf1e7a40fa052e6684aa498115bdb4209442fa74a425ee2e21); `web/e2e/sponsored.e2e.mts`). The passkey sign-in itself is the visitor's |
| Demo video (`web/e2e/demo.video.mts`) | recorder built 2026-11-12: Chromium through puppeteer against the page, every transaction real, a wallet whose demo keys sign in Node, captions and chapter cards, no scrolling on camera. Recorded so far: the register (an intent takes sRDDT past $250 and opens its round) and the pledges. The auction, trading, a halt and the unwind are recorded in market hours |
| Demand from elsewhere | **Hyperliquid built 2026-11-11**: a register cell not yet trading on Base gets a hairline tick when its HIP-3 perp has $100K or more of open interest or 24 h volume (29 cells on 11-11), and the detail shows both amounts and when they were read (`/api/elsewhere`, read at most every 5 minutes, through `ts/hip3.ts`, which the guard uses too). Robinhood Chain token supply is next. Display only: fills still price from Pyth. Counts are under "The numbers" |

First use (2026-11-07, with v1 intents; v2 also signs the token address, so that intent is to be signed
again): the author, in their own browser wallet, signed $250 of intent for SOFI. The
register then offered a round, they opened it, got test USDC, pledged 50 and took it back (the round
shows 0 pledged). One fix came out of it: the round page now makes the step you can take the primary
button (get test USDC first, then pledge). The first fill ran from the script on 2026-11-10 (above); a
fill and a trade from the page are next.

Docs:
- [docs/specs/001-summon.md](docs/specs/001-summon.md): the spec (r5)
- [docs/reviews/](docs/reviews): the reviews (Codex r1-r8 with each request, and what changed after each)
- [docs/design.md](docs/design.md): the web design

## The full flow on Base Sepolia

Every step of the spec's flow has run on Base Sepolia (2026-11-11 and 11-12 ET). `npm run e2e`, `npm run swap`
and `npm run demo -- <step>` print each transaction. The halt and the split are simulated: the demo operator
holds the guard key, the demo token's `OPERATOR_ROLE` and the testnet stand-in for the issuer's oracle
registry. Intents went to a local Worker with throwaway wallets, so the live board counts no signatures of ours.

| # | Step | On chain |
|---|---|---|
| 1 | The register shows a stock that was never minted | the page (`web/`, not public yet) |
| 2-3 | Signed intents reach $250 (3 signers, $260); a round opens from the board | `demo intents`: [openRound RIVN](https://sepolia.basescan.org/tx/0xad68483b8461e7844c11bec0a95d0c2ebc38b93b2c524c250f537d857666fdc5) |
| 4 | Backers pledge; one withdraws part while the round is Open | `e2e` (sGME, 300 tUSDC); `demo expire`: [carol withdraws 20](https://sepolia.basescan.org/tx/0x55e7ff8c734b882fce0b00cf99c9e0b2e77d8ec635893f36999d1e9b9f9cd739) |
| 5 | startAuction, fill at the reference less the spread, claims | `e2e`: [fill sGME](https://sepolia.basescan.org/tx/0xf46f8fa76f4306ab0bd1eae738b26c4d5e13cc65b9f44ef65ce9990602c52e9a) at $25.445, 6 bp |
| 6 | A trade in the backers' pool: 0.30% in session, 1.00% after the close | `swap`: [0.30%](https://sepolia.basescan.org/tx/0x973b9bcb0b1f11fdf94de03e9219c4c6e1fc6fe98e535c7ff46179a193c510cd), [1.00%](https://sepolia.basescan.org/tx/0x524cf5d54318c305b6e4d14bf354647f82c2bc16b8a76b3e45e8afd539b8e946) |
| 7 | A halt stops the pool | `demo halt`: [halt (manual)](https://sepolia.basescan.org/tx/0xc9753d0fe4c92c32a9697e9271d5a092252424a335256851560d6e75ecaac6fc) → swap refused `MarketHalted(5)` → [restored](https://sepolia.basescan.org/tx/0x4c3e0a84b1f0aae379246f71762060ac34e2d165180be2b57af0cebcddd08d78) → swaps again |
| 8 | A 2:1 split: no swaps in the window, none on the stale multiplier, then `realign` | `demo split`: [split scheduled](https://sepolia.basescan.org/tx/0xaa9a18690d660d893b7b2dbc24492073e771a52296a38a17e556e141c9197ff3) → `CorporateActionWindow` → `StaleMultiplier(1, 2)` → [registry](https://sepolia.basescan.org/tx/0xa799108b9f618657c4caf33caab8849b0587699a32e43725b5deef8fbd9019f9), [realign](https://sepolia.basescan.org/tx/0xaced708d6d025acf6d3802a21a9c493eeb5ee6144747a72c34fa0ee8aa12ef15) → [swap](https://sepolia.basescan.org/tx/0x926816218cf20303cc1107133a9d50ea64bd7781f283ee7603dc1a48494af3c9) |
| 9 | After the LP lock: `unwindLP`, each backer's `claimLP` (50/30/20) | `demo unwind`: [unwindLP](https://sepolia.basescan.org/tx/0xfd5dd63d11f30cfd87dee1bc7d6106ec7383dff83c7125e24a674030c5474e30), [alice](https://sepolia.basescan.org/tx/0xb50f04697c3aa589493cf7d270e711de61cfb25806811e966643860f9d2ba3b4), [bob](https://sepolia.basescan.org/tx/0xa024b9df9a1298930140c0b6bf74f3562b739711112ba8e5aad8917067c60f78), [carol](https://sepolia.basescan.org/tx/0xb3ad814d8a11ac80e3f4a57f2d83a228ed737757cd4cd7ac32a79d5c0b63cbad) |
| 10 | A round no one fills expires; refunds sum to what was pledged | `demo expire` (sAMC): [openRound](https://sepolia.basescan.org/tx/0x99fc2863994e06db61a8fe68ef9bca7cbbf7689c914fa77158d693e14ed07ad2), [bob 100](https://sepolia.basescan.org/tx/0x7344a02f630c9929f083e280688539890c6b878cccb64cbb82717714879af843), [carol 40](https://sepolia.basescan.org/tx/0xd7f1edc2474992c020519175f87b829d99b6e4afc09db3b38c184811e48d50c0) |

## Open question: who fills

Summon gives issuers a demand signal. It does not prove they will act on it. Stocks may sit unissued for
reasons other than demand: each mint has a fixed cost, plus legal and custody work. So the open question is
whether an issuer or authorized participant will fill a funded round. For them a fill is a mint against a
known buyer at the live price plus up to 1%, during market hours, so there is little inventory risk. But a
small round cannot cover a mint's fixed cost.

How Summon handles it:
- **A minimum target.** `SummonFactory.minTarget` is set by the owner (0 on testnet). It will be set from
  issuers' real fixed costs, which have not been asked yet. Whatever it says, a target is between 10 and
  10^9 USDC, and a round whose pool seed would be under 10^4 token units cannot start.
- **Intents before money.** Signed intents are free and show whether a ticker could reach that minimum. A
  round opens once they get close, so backers do not lock money in a round that cannot fill.
- **A clean exit.** If nobody fills, every pledge is refunded.
- **A reference filler.** `npm run keeper` starts an auction once the round accepts it, fills when the
  spread reaches a level the filler sets (`FILL_AT_BPS`, default 25 bp) or in the auction's last 2 minutes,
  and ends an auction nobody filled. It starts auctions on summoning days (Tuesdays and Thursdays, 10:00
  New York time), so backers know when to come back. It prints what the fill pays (the round's USDC for
  the stock, plus the spread) and a draft post for each fill. Any holder can run it; on testnet the demo
  filler wallet does.

Issuer policies on mainnet: Coinbase's stock tokens (NVDAc, MSTRc, GMEc, checked 2026-11-07) use a
blocklist-style transfer policy (id 5). Secondary transfers are open except to blocked addresses. Summon
checks these policies before every fill and claim.

## The numbers

Reproduce them with `python3 scripts/count_b20.py`. It reads public APIs and needs no keys.

| | 2026-11-07 |
|---|---|
| B20 tokenized stocks registered | 298 |
| minted (supply > 0) | 71 |
| never minted | 227 |
| with a Pyth US equity feed | 213 |
| never minted, with a Pyth feed (Summon can open a round) | 154 |

The same stocks elsewhere (read 2026-11-08 from public sources, no keys). Of the 227 never minted on B20:
- 80 are stock tokens on Robinhood Chain (212 tokens from its `StockFactory`
  `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`, chain 4663), including JPM, V, DIS, CRM and UBER;
- 24 trade as perps on Hyperliquid's HIP-3 markets, led by DELL (about $6.3M open interest; $5.9M on
  11-11). The register now reads this live and marks each stock with $100K or more of open interest or
  24 h volume;
- 164 are listed as xStocks (`api.backed.fi`). Backed lists 1,533 tokens, so a listing alone is not
  evidence of demand.

GME shows the gap on Base itself. Coinbase's GMEc is minted but has no pool, and Backed's older bGME on
Base ([`0x7212…2323`](https://basescan.org/address/0x7212088a11b4d8f6fc90fbb3dfe793b45dd72323)) has a
total supply of 0, while bNVDA has about 7,063.

Base's Chainlink equity feeds cover 10 liquid tickers, so Summon prices from Pyth. Pyth gives the
underlying share price, and a B20 token is worth underlying × `multiplier()`.
[`SummonPrice`](src/SummonPrice.sol) applies the multiplier exactly once.

## Quickstart

```sh
git clone --recursive <this repo>
cd summon-stocks
forge test
```

Requires [Foundry](https://getfoundry.sh). It builds with `via_ir` (foundry.toml): without it the factory,
which carries the round's creation code, is over the 24,576-byte contract limit. The B20 precompiles exist only on Base and Base Sepolia, not on
anvil, so unit tests use mocks and the end-to-end run broadcasts to Base Sepolia.

## Run it on Base Sepolia

Everything runs on Base Sepolia with testnet funds. The demo stock is a real B20 Asset, the same standard
as Coinbase's tokenized stocks, created through the B20 factory precompile. Its symbol is `sGME`, it
tracks GME's Pyth price, and it has no value.

```sh
npm install
# .env: DEMO_MNEMONIC (testnet wallets: 0 operator, 1-3 backers, 4 filler); PYTH_API_KEY only for
#       PRICE_SOURCE=pyth (Pyth Terminal, app.pyth.com: Hermes needs a key since 2026-08-26)
set -a; . ./.env; set +a                       # so forge sees DEMO_MNEMONIC
npm run fund                                   # operator -> demo wallets, for gas
DRY_RUN=1 npm run create-stock                 # simulate; needs no funds
npm run create-stock                           # prints STOCK_TOKEN
STOCK_TOKEN=0x… PRICE_ID=0x6f9cd89ef1b7fd39f667101a91ad578b6c6ace4579d5f7f285a4b06aa4504be6 \
  PRICE_SOURCE=guard forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --mnemonics "$DEMO_MNEMONIC"
npm run guard                                  # keep running: session, halts (and, for guard pricing, the quote)
npm run e2e                                    # trading days 09:45-15:35 ET (12:35 on early closes)
npm run swap                                   # one trade in the filled pool; prints the fee the hook charged
npm run demo -- intents                        # signed intents reach $250 on a local Worker; a round opens
npm run demo -- halt                           # a halt stops the pool (stop the guard first)
npm run demo -- split                          # a 2:1 split: window, stale multiplier, realign (run again after 1 h)
npm run demo -- unwind                         # after the LP lock: unwindLP and each backer's claimLP
npm run demo -- expire                         # AMC: a round no one fills, a withdrawal, refunds (run again after 1 h)
npm run keeper                                 # keep running: start, fill and end auctions (DRY_RUN=1 to watch)
```

**Price source.** Each listed token is bound to one feed, chosen by the factory owner:
- `PRICE_SOURCE=pyth`: Pyth Core, with update data from Hermes. This is the design Summon is built for.
  Since 2026-08-26 Hermes needs an API key, which must stay on a server.
- `PRICE_SOURCE=guard` (the default on testnet): `GuardPriceFeed`, which has Pyth's read interface. The
  demo guard posts a stock's price there while it is open and not halted, and only while its round is
  Funded or in its auction. The price is the HIP-3 oracle price of the stock's perp on Hyperliquid
  (GME, RIVN and RDDT on `xyz`, SOFI on `para`; AMC has none, so sAMC cannot fill with guard pricing).
  It is public chain state, read through Hyperliquid's info API with no key. Treat it as demo data only:
  - a HIP-3 deployer sets its own oracle price, so it is not a price to back real funds;
  - until 2026-11-09 the guard read Nasdaq.com's quote endpoint. Nasdaq's terms (nasdaq.com/legal) forbid
    "any process, whether automated or manual, to capture data or content from the Service", so it no
    longer does. The halts still come from Nasdaq Trader's Trade Halt RSS feed, whose own terms allow
    this use (they forbid altering the feed), read at most once a minute as its page asks.

  The guard key already decides whether the market is open. With guard pricing, it also sets the price.

Both sources go through the same checks in the round: the price is fresh (a guard price at most 60 s old;
a Pyth price, the first print after the time the block sets), its confidence is within 50 bp, and it has
not jumped more than 3% since the auction started. A guard that stops posting therefore stops fills.

**Deployed on Base Sepolia** (2026-11-11, with the stock-aware pool; priced from the guard feed; addresses
also in `deployments/84532.json`). The five demo stocks are the ones created on 2026-11-07, listed again in
the new factory. The first deployment (2026-11-07, factory `0xe059…c691`, which ran the first fill) had a
hook that gated only pool initialization; it stays on chain but the page and scripts no longer use it:

| Contract | Address |
|---|---|
| SummonFactory | [`0xc1Dc57aEf69e96B7817fC801f003AFA1a59EE7B9`](https://sepolia.basescan.org/address/0xc1Dc57aEf69e96B7817fC801f003AFA1a59EE7B9) |
| SummonHook | [`0x13F9D81A93Ae3906551cC7D89A99D5b949D3e880`](https://sepolia.basescan.org/address/0x13F9D81A93Ae3906551cC7D89A99D5b949D3e880) |
| Demo stock sGME (B20 Asset) | [`0xB20000000000000000000065bC5A9eB6218d9E68`](https://sepolia.basescan.org/address/0xB20000000000000000000065bC5A9eB6218d9E68) |
| Demo stock sAMC (B20 Asset, tracks AMC) | [`0xb20000000000000000000084246F11C15C326DD9`](https://sepolia.basescan.org/address/0xb20000000000000000000084246F11C15C326DD9) |
| Demo stock sRIVN (B20 Asset, tracks RIVN) | [`0xB2000000000000000000007ad0F0FeF5d2b4A11E`](https://sepolia.basescan.org/address/0xB2000000000000000000007ad0F0FeF5d2b4A11E) |
| Demo stock sSOFI (B20 Asset, tracks SOFI) | [`0xB2000000000000000000006b9fb9a28A08243AC4`](https://sepolia.basescan.org/address/0xB2000000000000000000006b9fb9a28A08243AC4) |
| Demo stock sRDDT (B20 Asset, tracks RDDT) | [`0xb200000000000000000000Ba2c05b1Ca0D438CF8`](https://sepolia.basescan.org/address/0xb200000000000000000000Ba2c05b1Ca0D438CF8) |
| SummonSwap | [`0x6C584a7B9eD6C2137494fFd3D651713B175c6527`](https://sepolia.basescan.org/address/0x6C584a7B9eD6C2137494fFd3D651713B175c6527) |
| GuardPriceFeed (testnet) | [`0x28391F43f46937a34B91d04B3A7192e9f184E6Ca`](https://sepolia.basescan.org/address/0x28391F43f46937a34B91d04B3A7192e9f184E6Ca) |
| MarketStateRegistry | [`0x4a0bFd56fd81f06Bc4A56Df34834d50d3B9141d7`](https://sepolia.basescan.org/address/0x4a0bFd56fd81f06Bc4A56Df34834d50d3B9141d7) |
| DemoOracleRegistry (testnet) | [`0x0BeBe0Cf32A4Ca437A711fa5E81b125765eE7452`](https://sepolia.basescan.org/address/0x0BeBe0Cf32A4Ca437A711fa5E81b125765eE7452) |
| TestUSDC (testnet) | [`0xEC269118226b61d6766ea63da34B99786df68dc5`](https://sepolia.basescan.org/address/0xEC269118226b61d6766ea63da34B99786df68dc5) |

The deploy script finds a CREATE2 salt that puts the hook at an address with exactly its flags
(BEFORE_INITIALIZE, BEFORE_ADD_LIQUIDITY, BEFORE_SWAP). Contracts used on Base Sepolia: Uniswap v4 PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`,
Pyth `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`, and the B20 policy registry precompile
`0x8453…0002`. Three contracts exist on testnet only, and all are labelled as such: `TestUSDC`, which
anyone can mint; `DemoOracleRegistry`, which stands in for Coinbase's mainnet oracle registry; and
`GuardPriceFeed`.

## Web

`web/` is the page and a Cloudflare Worker. Four tabs stay at the top of every page: the register of all
298 stocks, each with its own guilloché seal (one screen: the cells and the chosen stock's panel scroll
inside it), the rounds, My summons, and how it works. A round page fits one screen: a dial that fills with pledges, runs with
the auction's spread and shows the pool's fee, and a ticket that shows what an order gets before it is
signed. Its numbers come from the chain: a swap is quoted through the pool and its hook (Uniswap's
V4Quoter), pledges and fills use the round's own integer math, and every transaction is simulated before
it is sent, so a refusal is the contract's own error. A backer sees their stock, pool share and the fees
it has earned against what they pledged. The Worker stores signed intents and exports them at
`/api/demand`, with signatures, so an issuer can verify the totals itself; the register's "Check every
signature" does that in the browser. "My summons" (`#/me`) lists every round a wallet backed with what it
can do next (claim, take the pool share, refund, or wait and until when), its intents and the stocks it
follows. Following, Telegram alerts and sharing are one "keep up" block, always the last thing in a
stock's panel or round ticket, headed by what comes next (the next summoning, "You're in", "Summoned").
Each stock has a share link, `/s/TICKER`: its preview shows the stock's card (made at build time by
`npm run og`, 1200×630) and the live numbers (intents, backers, the demo round's state). Link-preview
fetchers may read that page and its card from anywhere, since X's runs from the US; the site itself stays
closed to US visitors. `/api/elsewhere` gives the register its Hyperliquid marks. It checks each EIP-712 signature. An intent names the stock by ticker and by its B20
contract address, and the address must match the snapshot: Base's docs say to identify a stock by address,
because its symbol can be changed. The Worker keeps one intent per wallet per stock, and refuses the project's own demo wallets, so the board never counts them. Each network may write 20
intents an hour and add 5 new wallets a day. The page's transactions carry a Base Builder Code (ERC-8021)
once one is registered (`BUILDER_CODE` in `web/src/chain.ts`, empty for now); the demo scripts' do not. The whole site, page and API, is closed to US visitors
(HTTP 451): Coinbase tokenized stocks are not offered to US persons, and projects that enable trading for
US users are out of scope. `npm run test:worker` checks these rules. The design notes are in
[docs/design.md](docs/design.md).

Wallets: the page lists every wallet installed in the browser (EIP-6963) and offers Base Account, which
needs no extension. With a CDP Paymaster key, Base Account's transactions are sponsored, so a visitor needs
no testnet ETH, and an order's steps (approve, then pledge) go as one batch. The key stays in the Worker:
`/api/paymaster` forwards ERC-7677 requests to CDP only when every call goes to Summon's contracts or to a
round the factory created, and sends no ETH (CDP's own allowlist names contracts, and every round is new).
Inside Coinbase Wallet's app (the Base app before it was renamed), whose browser opens any web page, the page
uses that wallet without a picker, and sends a sponsored batch when the wallet says it takes a paymaster.

Alerts: a Telegram bot follows demo stocks for people (`web/worker/alerts.ts`). "Alerts on Telegram" on the
register and round pages opens it already following the stock; it then says when the stock's round opens,
fills up, goes to auction, is summoned or expires, and 15 minutes before a summoning that will start its
auction. A cron reads the rounds every minute and queues one message per follower in a Durable Object
(40 sent a minute, the rest wait); the first read after a deploy only records. It keeps a Telegram chat id
and its tickers, nothing about a wallet, answers only in private chats, and `/stop` forgets the chat. The
webhook is checked by its secret, not the country, since Telegram's servers may be in the US; the bot
only links to the site, which stays closed there.

```sh
python3 scripts/snapshot.py        # refresh web/public/b20.json (the Coinbase API has no CORS)
cd web && npm install
npm run build && npx wrangler dev  # page and Worker on http://localhost:8787
npx wrangler secret put CDP_PAYMASTER_URL   # optional: https://api.developer.coinbase.com/rpc/v1/base-sepolia/<key>
                                   # locally, the same line in web/.dev.vars
# optional, alerts: a bot from @BotFather, then
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
npm run telegram                   # sets the webhook to SITE_URL/api/telegram; then TELEGRAM_BOT_NAME and
                                   # SITE_URL under [vars] in wrangler.toml, and deploy
```

## Not a Tokenized Securities Venue

The SEC's Innovation Exemption (Release 34-106402, 2026-09-17) lets a Tokenized Securities Venue (TSV) trade
tokenized US stock in permissioned AMM pools without registering as an exchange. Its conditions include
permissioned access, per-tier caps on symbols and volume, halts in step with the primary exchange, public
trade data and, for tokens made by someone other than the company, written notice to the company at least
30 days before trading with a chance to object. Summon is not a TSV. It runs on testnet and does not serve US
persons. A US mainnet version would have to meet those conditions. Most of all, a funded round could not
trade on day one: the company's 30-day notice would come first. Of the conditions, Summon's market-state
check covers only the halts.

## Parts used

- [hl-price-guard](https://github.com/fabrknt/hl-price-guard) (pinned at `v0.4.0`): `PythRef` for the
  Pyth read and confidence bound, and `JumpLatch` for the jump guard. Summon needed a Pyth-only staleness
  check, so it was added upstream first (`PythRef.readFresh`, `v0.3.2`), not worked around here. Codex r3
  then showed a filler could still pick among fresh prints, so `PythRef.readFirstAfter` (the first print
  after a set time) was added upstream in `v0.4.0` and Pyth listings settle through it.
- [market-state](https://github.com/fabrknt/market-state) (pinned at `v0.4.0`): `MarketStateCheck.requireOpen`
  on every auction start and fill, and the Nasdaq Trader halts guard. Using it here showed the guard did
  not know exchange holidays (Thanksgiving read as open), so `v0.2.0` added NYSE's 2026-2028 holidays and
  13:00 early closes upstream first, and `v0.3.0` the `core-hours` session (no fills while US LULD bands
  are doubled). After a stale `node_modules` read `core-hours` as always open (the hook charged the
  open-session fee after the close), `v0.4.0` made an unknown session name read closed
  ([#1](https://github.com/fabrknt/market-state/issues/1)). The registry fails closed when the
  updater goes quiet. It was extracted from another of our projects as a public part, so that Summon could
  depend on it through a tag. That project now depends on the same tag.
- [Uniswap v4-core](https://github.com/Uniswap/v4-core) v4.0.0,
  [pyth-sdk-solidity](https://github.com/pyth-network/pyth-sdk-solidity) v2.2.0,
  [base-std](https://github.com/base/base-std) v1.1.0.

## Built during the season

Everything in this repository was written during the Stocks Maxxing season (from 2026-11-07). The parts
listed above existed before it.

## Notes

- Not affiliated with, or endorsed by, Base, Coinbase, Pyth, Uniswap or any listed company.
- Tickers are shown as text only. A Summon round gives backers a token that tracks a stock. It gives no
  shareholder rights, such as voting.
- Coinbase tokenized stocks are not available to US persons. Summon does not serve US users.
- Unaudited. Testnet only. Do not use with real funds.

## License

Apache-2.0
