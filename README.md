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
| Stock-aware pool (`SummonHook`, `SummonRound.realign`, spec 5.5 and 5.5a, r4) | built 2026-11-08, deployed 2026-11-11, **first trade 2026-11-11 (ET)**: alice bought sGME with 1 tUSDC in the summoned pool and the hook charged 0.30%, the open-session fee ([swap](https://sepolia.basescan.org/tx/0x973b9bcb0b1f11fdf94de03e9219c4c6e1fc6fe98e535c7ff46179a193c510cd), `npm run swap`). The rules: no swaps in a corporate action window, while the multiplier differs from the one the pool was priced at, or while the listing exchange has the stock halted; a 1.00% fee instead of 0.30% while the session is closed or the guard is quiet; after a split or a dividend in shares, anyone can `realign` the backers' pool to the new multiplier, so the first trader cannot take the difference. No fills in the first 15 and last 25 minutes of the session, while US LULD bands are doubled (market-state `core-hours`). Holidays and 13:00 early closes from market-state `v0.2.0` |
| Base Sepolia deployment | **redeployed 2026-11-11 with the stock-aware pool** (Codex r8 approved): factory, hook, swap router, registries, and the five B20 demo stocks listed again (see below). sGME's round [`0x5408…0119`](https://sepolia.basescan.org/address/0x5408232bFf80179f25414A274B7fAabD9bC00119) filled on 11-11; the other four have none open yet (the e2e script or the register opens them). The first deployment (2026-11-07) ran the first fill: sGME round [`0xa799…046D`](https://sepolia.basescan.org/address/0xa799fC499Af97a474D02878fC10fB8B733b1046D) |
| Guard (`ts/guard.ts`) | done: Nasdaq Trader halts (once a minute) and, for guard pricing, the HIP-3 oracle price from Hyperliquid's chain. It writes nothing while the market is closed. `npm run guard -- --quote GME` prints the price it would post and writes nothing |
| End-to-end fill on Base Sepolia (`ts/e2e.ts`) | **first fill done 2026-11-10 (ET), sGME**: three demo backers pledged 300 tUSDC, the auction started, and the demo filler filled at a $25.115 reference (the HIP-3 oracle price the guard posted), 6 bp under it; the Uniswap v4 pool was seeded and every backer claimed. [pledge](https://sepolia.basescan.org/tx/0x3dbe7c7ad11fdd223ddeab48fbc05393fa85a334a9a2b7ed7054433b7cd7a60c) · [auction start](https://sepolia.basescan.org/tx/0x4b5831f2ca5fc62b8695315ca29670eb433421307826bad32aef927df572bb9a) · [fill](https://sepolia.basescan.org/tx/0xb71b8eb7f4cf16fd1bb060b11247b29741a0caf7151036d79965f09497ffb9eb) · [claim](https://sepolia.basescan.org/tx/0xda9dddb16b677e784f2d4bd6868c5e01fefbd6b699f63f7cc8d36d9e75b3b5dc). **Second fill 2026-11-11 (ET), on the redeployed contracts**: sGME again, at a $25.445 reference, 6 bp under it ([open](https://sepolia.basescan.org/tx/0x6f720a4b1dcc759878dcdcdd3e38674a4757bcaa4be5a94abe04fa2d9737f14f) · [auction start](https://sepolia.basescan.org/tx/0x0f3abf7c6f71df87c76b856317ea030481742736ba3772a5ea1d80c3fc745206) · [fill](https://sepolia.basescan.org/tx/0xf46f8fa76f4306ab0bd1eae738b26c4d5e13cc65b9f44ef65ce9990602c52e9a) · [claim](https://sepolia.basescan.org/tx/0xa03085d3b475d0f69be5a66fb3b4e1e99303fbf2f1e102f61f5a8db875196f94)). It picks up the stock's open round wherever it stands, so pledges made from the web page count. On a Pyth listing it moves to a later price band only when Pyth printed nothing in the one it tried. Weekdays 09:45–15:35 ET |
| Web (`web/`) | built 2026-11-07: the register of all 298 stocks; live round pages; signed intents, with a round opening from the register once a demo stock's intents reach $250; trading a summoned pool; a demand export issuers can verify; the US block and per-network limits (23 Worker tests, intents in one Durable Object so nonce checks and limits are exact, with totals kept per token (named by the current snapshot) and live intents and nonces capped: totals count only unexpired intents, a replay sent with its replacement loses, expired intents are swept, the demand export is paged, an intent lasts at most 31 days, an older signature cannot restore a replaced intent, a nonce far ahead is refused, and a request with no country is refused). Runs locally. Not public yet: the code review is done, and the author decides when |
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
npm run guard                                  # keep running: halts (and, for guard pricing, the quote)
npm run e2e                                    # trading days 09:45-15:35 ET (12:35 on early closes)
npm run swap                                   # one trade in the filled pool; prints the fee the hook charged
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

`web/` is the page and a Cloudflare Worker. The page shows the register of all 298 stocks, each with
its own guilloché seal, and a round page that reads the fill conditions live from Base Sepolia. The
Worker stores signed intents and exports them at `/api/demand`, with signatures, so an issuer can verify the
totals itself. `/api/elsewhere` gives the register its Hyperliquid marks. It checks each EIP-712 signature. An intent names the stock by ticker and by its B20
contract address, and the address must match the snapshot: Base's docs say to identify a stock by address,
because its symbol can be changed. The Worker keeps one intent per wallet per stock, and refuses the project's own demo wallets, so the board never counts them. Each network may write 20
intents an hour and add 5 new wallets a day. The page's transactions carry a Base Builder Code (ERC-8021)
once one is registered (`BUILDER_CODE` in `web/src/chain.ts`, empty for now); the demo scripts' do not. The whole site, page and API, is closed to US visitors
(HTTP 451): Coinbase tokenized stocks are not offered to US persons, and projects that enable trading for
US users are out of scope. `npm run test:worker` checks these rules. The design notes are in
[docs/design.md](docs/design.md).

```sh
python3 scripts/snapshot.py        # refresh web/public/b20.json (the Coinbase API has no CORS)
cd web && npm install
npm run build && npx wrangler dev  # page and Worker on http://localhost:8787
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
- [market-state](https://github.com/fabrknt/market-state) (pinned at `v0.3.0`): `MarketStateCheck.requireOpen`
  on every auction start and fill, and the Nasdaq Trader halts guard. Using it here showed the guard did
  not know exchange holidays (Thanksgiving read as open), so `v0.2.0` added NYSE's 2026-2028 holidays and
  13:00 early closes upstream first, and `v0.3.0` the `core-hours` session (no fills while US LULD bands
  are doubled). The registry fails closed when the
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
