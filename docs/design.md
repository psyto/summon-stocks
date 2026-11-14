# Summon web: design plan (2026-11-07)

## Subject, audience, job
- Subject: tokenized stocks that are registered on Base but have never been issued, and the rounds that
  bring them on.
- Audience: Base judges and crypto-native backers first; issuers and authorized participants second.
- Primary job: in five seconds, show that 227 of 298 registered stocks have never been issued. Then let a
  visitor back one.

## Concept: the share certificate
A stock used to arrive as an engraved certificate: security paper, a guilloché rosette, intaglio ink, a
red seal. Summon "issues" stocks onto Base, so the page takes that vernacular and makes it generative.
**Every ticker gets its own guilloché rosette**, computed from the ticker. The rosette's state is the data:
- **never issued**: drawn in faint uninked lines
- **issued, no pool**: inked
- **trading on Base**: inked, with the red seal at its centre

The register of all 298 rosettes is the hero visualisation, built from real data.

First idea, rejected: a Base-blue (#0000FF) exchange board with amber LEDs. It is striking, but a page in
Base's own blue reads as an official Base product. The rules (§6) forbid implying endorsement.

## Tokens
Color (security paper, intaglio ink; no cream, no terracotta, no near-black field):
- `--paper`   #ECF0EC  cool green-grey security paper
- `--ink`     #0E4A3B  intaglio green (the main ink: text, inked rosettes)
- `--ink-2`   #14211C  green-black for body text
- `--faint`   #B7C7BF  uninked engraving lines (never issued)
- `--seal`    #A4161A  certificate seal red. Used only for "trading", the primary action, and halts
- `--rule`    #CBD6D0  hairlines in tables

Type: one family, two widths. Archivo (variable width axis).
- Tickers, numerals and display: Archivo Expanded (wdth 125), weight 700–800. Tickers are capitals by
  nature; nothing else is set in all caps.
- Body and UI: Archivo, wdth 100, weight 400/500. Tabular figures for numbers.
- Scale (1.25): 13 / 16 / 20 / 25 / 31 / 39 / 61 / 96.

Layout:
```
 Summon                                   Base Sepolia testnet   [Connect wallet]
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  (large rosette, drawing itself)   227 of 298 stocks registered on Base   │
 │                                    have never been issued.                │
 │                                    Back one. When the round fills, it     │
 │                                    trades, with a pool its backers own.   │
 └───────────────────────────────────────────────────────────────────────────┘
 Register  [Never issued 227] [Issued, no pool 26] [Trading 45]     search
 ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐   ┌─ selected ticker ───────────────────┐
 │◌ │◌ │◉ │◌ │◎ │…                │   │ rosette  GME                        │
 │  register: 298 cells, rosette   │   │ GameStop Corp. · status · feed      │
 │  + ticker, sorted by intent     │   │ backers, total intent               │
 └─────────────────────────────────┘   │ [$ amount] [Sign intent]            │
                                        └─────────────────────────────────────┘
 How a round fills  (a real sequence, so it is numbered)
 1 Backers pledge  2 The auction opens  3 A holder fills  4 Backers claim
```
- Left-aligned throughout. The certificate frame (a guilloché border) appears in two places only: the hero
  and the round page.
- Round page: one certificate. The fields are the ticker, pledged / target, the state sequence, a spread
  ramp chart, and the fill conditions read live from Base Sepolia (each one names its source).

Principles:
1. The rosette is the one bold thing. Everything else is quiet: hairlines, paper, ink.
2. State is drawn, not badged: ink density and the seal carry status. No coloured pills.
3. One orchestrated motion: the hero rosette draws itself on load. Nothing else animates by itself:
   what moves on the round page moves because the chain did (see "Round page, redone"). Reduced motion
   shows everything still.
4. Every number names where it came from (API snapshot time, block, feed age).
5. Honest testnet: the demo stock, test USDC and demo wallets say so wherever they appear.

## Review against the brief
- Is it generic? The closest default is the cream and serif "editorial" look. This plan uses cool green
  paper, a seal red rather than terracotta, and one variable grotesk family with no serif display. The
  rosette system exists only because of this subject.
- Risks: a rosette in every cell could look busy. Answer: cells are small, lines are 0.6 px, and only
  state changes the ink. Check this on a screenshot.
- Data honesty: the snapshot shows its time. Volume and pool data come from GeckoTerminal.

## Built (2026-11-07)
- Hero: the seal engraves itself once (2.6 s, staggered strands); reduced motion shows it drawn. The
  headline is "Registered on Base. Never issued." The seal carries the number, like a certificate's
  denomination. Changed after the first screenshot: the first headline repeated "227", and a single dense
  band read as a wreath, not engraving. Now there are two bands of fine, translucent lines.
- Register: 298 seals in a stamp-sheet grid, sorted by signed intent. A cell shows its total in seal red.
- Round page: one certificate (double rule). Pledged, the state sequence, the spread ramp chart, and six
  fill conditions read live from Base Sepolia (about 2 s, refreshed every 15 s). Each condition names its
  source.
- Checked: 1440 px and 390 px (no horizontal scroll), light and dark.
- First use by the author (11-07): with Pledge always enabled, the order (get test USDC, then pledge) was
  unclear. The round page now makes whichever step can be taken the primary button. Pledge stays disabled
  until there is test USDC, and the amount is checked against the balance and the room left.

## Round page, redone (2026-11-12)
Set beside the trade page of another of our projects, the certificate round page read as a document: little changed when
something happened, and the demo had to be told in a terminal. Now:
- One screen at 1440×900, no scrolling: the seal sits inside a 270° dial. Open: the dial fills with
  pledges, and the amount being chosen shows as a dashed arc before anything is signed. Auction: the dial
  is the spread, moving each second, because the contract's spread does. Filled: the pool's fee, or a red
  dashed ring when the hook stops trading. Under it, one big number and three tiles.
- A ticket on the right says what an order gets before it is signed, with numbers from the chain: a swap
  quoted through the pool and its hook (V4Quoter), pledges and fills by the round's integer math, every
  transaction simulated first so a refusal is the contract's own error.
- Motion follows the chain: reads every 4 s while a round moves, the dial glides between reads, the big
  number counts up. The fill conditions fold below the screen.
- Still Summon's: paper, ink and seal red, the rosette at the centre. Not the dark trading look of that other project,
  so the two do not read as one product.
- Filmed end to end on 11-12 (ET) for the demo video. One thing came out of it: after the unwind, the
  position dropped a backer's pool share once it was claimed, so it read as a loss. It now values the
  share from what the round took out of the pool, claimed or not. Times on the page follow the viewer's
  clock; the video is recorded on New York time, the market's own.

## One frame (2026-11-12, late)
Set beside that page again, the page read as scattered: the demo moved through seven layouts, the new
features sat as small pills by the title, and pages jumped. Now the tabs (Register, Rounds, My summons,
How it works) stay at the top; the register fits one screen under a one-line intro (the pitch moved to
How it works); follow, alerts and share are one "keep up" block at the foot of the panel or ticket, headed
by what comes next.
- The first screen is Now, not the register: that page opens on one name and one action, while the
  register opened on 298 faint seals in alphabetical order with GME selected at $0. Now shows the liveliest
  round in the round page's own frame, then "Which stock next?" ranked by signed intents.

## Bringing people back (2026-11-12)
A round takes days: intents, then pledges, then a summoning. People who signed once need a reason and a
time to come back.
- A share link per stock (`/s/TICKER`) whose preview carries the stock's card and its live numbers.
- "My summons": what each round a wallet backed needs from it next.
- Summoning days: funded rounds' auctions start on Tuesdays and Thursdays at 10:00 New York time, so there
  is a moment to watch, and something to post after.
- Telegram alerts instead of a mini app. Base's mini apps were retired (Base's docs, read 11-12): the Base
  app became Coinbase Wallet, whose browser opens any web page, so the page itself is the Base app's way
  in. A Farcaster mini app would need a public domain and a signed manifest, and its wallet's Base Sepolia
  and paymaster support are not confirmed; it can come after the site is public. Telegram needs neither,
  and a message on a phone is what brings someone back for a 10:00 ET auction.

## Demand from elsewhere (planned 2026-11-08; Hyperliquid built 2026-11-11, Robinhood Chain to come)
- On the register, a never-minted stock that already trades elsewhere gets a mark: Hyperliquid HIP-3 (open
  interest and 24 h volume) or Robinhood Chain (token supply). The mark is set by an amount, never by a
  listing alone. xStocks lists 164 of the 227, so a listing alone would mark nearly every cell.
- Quiet, like everything but the rosette: a hairline tick in the cell, with the amount and its source and
  read time in the cell's detail (principle 4). No coloured badges (principle 2).
- The framing is "stocks with proven demand come to Base first", not "Base is behind".
- Hyperliquid prices are shown for reference only. A HIP-3 deployer sets its own oracle, so fills keep
  pricing from Pyth.
- Built (Hyperliquid): the Worker's `/api/elsewhere` reads every HIP-3 dex at most once per 5 minutes
  (`ts/hip3.ts`, shared with the guard) and keeps the last read if Hyperliquid fails. A cell not yet trading
  on Base gets a 10 px hairline tick at its top right when open interest or 24 h volume is $100K or more:
  29 cells on 11-11. The detail adds a "Hyperliquid perp" row with both amounts, the dex, "matched by ticker"
  and the read time. HIP-3 lists only tickers, so the match is by ticker; the doubtful ones were checked by
  hand on 11-11 (BIRD is Allbirds, renamed Smartbird in 2026-06), and every match is on a stock-perp dex.
