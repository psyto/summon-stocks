/**
 * Round alerts on Telegram: people follow a demo stock with the bot and hear when its round opens, fills
 * up, goes to auction, is summoned or expires, and 15 minutes before a summoning that will start its
 * auction. Nothing about a wallet is asked or kept: only the Telegram chat id and the tickers it follows.
 *
 *   POST /api/telegram   Telegram's webhook (checked by its secret-token header). Commands: /start [TICKER],
 *                        /follow TICKER, /unfollow TICKER, /list, /stop. Replies go back in the webhook's
 *                        response, so a command costs no outbound call.
 *   GET  /api/alerts     -> { bot } when the bot is set up, else 503 (the page then shows no link)
 *   cron, every minute   reads each demo stock's latest round and messages its followers on a change
 *
 * AlertStore is one Durable Object, so a state change is announced once even if two ticks overlap. The
 * first time a round is seen it is recorded, not announced (a deploy must not message everyone).
 */
import { nextSummoning, summoningLabel } from "../../ts/schedule";
import { dep, latestRound, type Latest } from "./rounds";
import type { Storage } from "./store";

export interface AlertEnv {
  ALERTS: DurableObjectNamespace;
  /** secrets: the bot's token from @BotFather, and the webhook secret given to setWebhook */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** vars: the bot's username (without @) for the page's links, and the site's origin for the messages */
  TELEGRAM_BOT_NAME?: string;
  SITE_URL?: string;
}

/** Bounds: tickers per chat, and chats in all. */
export const MAX_FOLLOWS = 20;
export const MAX_CHATS = 20_000;
/** How long before a summoning its reminder goes out. */
export const REMIND_SECONDS = 15 * 60;
/** Messages sent per tick (a Worker invocation may make 50 outbound calls on the free plan); the rest wait. */
export const SEND_PER_TICK = 40;
const MAX_OUTBOX = 100_000;

type Told = Latest & { text: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export class AlertStore {
  private sql: Storage["sql"];

  constructor(ctx: { storage: Pick<Storage, "sql"> }, _env?: unknown) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS follows (chat INTEGER NOT NULL, ticker TEXT NOT NULL, PRIMARY KEY (chat, ticker))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS follows_ticker ON follows (ticker)`);
    // the last round and state announced per stock
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seen (ticker TEXT PRIMARY KEY, round TEXT NOT NULL, state INTEGER NOT NULL)`);
    // summoning reminders already sent: "<window start>:<round>"
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reminded (k TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, text TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY)`);
  }

  /** One message per follower of `ticker`. The queue is bounded: past MAX_OUTBOX the oldest go. */
  private queue(ticker: string, text: string) {
    this.sql.exec(`INSERT INTO outbox (chat, text) SELECT chat, ? FROM follows WHERE ticker = ?`, text, ticker);
    this.sql.exec(`DELETE FROM outbox WHERE id <= (SELECT MAX(id) FROM outbox) - ?`, MAX_OUTBOX);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const b = (await req.json()) as { chat?: number; ticker?: string; rounds?: Told[]; window?: number; funded?: Told[]; limit?: number; messages?: { chat: number; text: string }[] };
    if (path === "/follow") {
      const mine = this.sql.exec(`SELECT ticker FROM follows WHERE chat = ?`, b.chat).toArray();
      if (mine.some((r) => r.ticker === b.ticker)) return json({ ok: true });
      if (mine.length >= MAX_FOLLOWS) return json({ error: `You follow ${MAX_FOLLOWS} stocks already. /unfollow one first.` });
      if (!mine.length && Number(this.sql.exec(`SELECT COUNT(DISTINCT chat) AS n FROM follows`).toArray()[0]!.n) >= MAX_CHATS) return json({ error: "The bot is full for now. Try again later." });
      this.sql.exec(`INSERT INTO follows (chat, ticker) VALUES (?, ?)`, b.chat, b.ticker);
      return json({ ok: true });
    }
    if (path === "/unfollow") {
      this.sql.exec(`DELETE FROM follows WHERE chat = ? AND ticker = ?`, b.chat, b.ticker);
      return json({ ok: true });
    }
    if (path === "/stop") {
      this.sql.exec(`DELETE FROM follows WHERE chat = ?`, b.chat);
      this.sql.exec(`DELETE FROM outbox WHERE chat = ?`, b.chat);
      return json({ ok: true });
    }
    if (path === "/list") return json({ tickers: this.sql.exec(`SELECT ticker FROM follows WHERE chat = ? ORDER BY ticker`, b.chat).toArray().map((r) => String(r.ticker)) });
    if (path === "/changes") {
      // queue a message to each follower of a round whose (address, state) differs from the last one seen.
      // Before the first tick nothing is known, so that tick only records.
      const known = this.sql.exec(`SELECT k FROM meta WHERE k = 'init'`).toArray().length > 0;
      for (const r of b.rounds ?? []) {
        const was = this.sql.exec(`SELECT round, state FROM seen WHERE ticker = ?`, r.ticker).toArray()[0];
        if (was && was.round === r.round && Number(was.state) === r.state) continue;
        this.sql.exec(`INSERT OR REPLACE INTO seen (ticker, round, state) VALUES (?, ?, ?)`, r.ticker, r.round, r.state);
        if (known) this.queue(r.ticker, r.text);
      }
      this.sql.exec(`INSERT OR IGNORE INTO meta (k) VALUES ('init')`);
      return json({ ok: true });
    }
    if (path === "/remind") {
      for (const r of b.funded ?? []) {
        const k = `${b.window}:${r.round}`;
        if (this.sql.exec(`SELECT k FROM reminded WHERE k = ?`, k).toArray().length) continue;
        this.sql.exec(`INSERT INTO reminded (k, at) VALUES (?, ?)`, k, b.window);
        this.queue(r.ticker, r.text);
      }
      this.sql.exec(`DELETE FROM reminded WHERE at < ?`, (b.window ?? 0) - 30 * 86_400);
      return json({ ok: true });
    }
    if (path === "/take") {
      // the oldest queued messages, taken off the queue; the Worker sends them and puts back what Telegram refused for now
      const rows = this.sql.exec(`SELECT id, chat, text FROM outbox ORDER BY id LIMIT ?`, b.limit ?? SEND_PER_TICK).toArray();
      if (rows.length) this.sql.exec(`DELETE FROM outbox WHERE id <= ?`, rows[rows.length - 1]!.id);
      return json(rows.map((r) => ({ chat: Number(r.chat), text: String(r.text) })));
    }
    if (path === "/again") {
      for (const m of b.messages ?? []) this.sql.exec(`INSERT INTO outbox (chat, text) VALUES (?, ?)`, m.chat, m.text);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
}

function alerts(env: AlertEnv) {
  const s = env.ALERTS.get(env.ALERTS.idFromName("all"));
  return async <T>(path: string, body: unknown): Promise<T> =>
    (await (await s.fetch(`https://alerts${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json()) as T;
}

const demoFor = (t: string) => dep.demoStocks.find((d) => d.ticker === t.toUpperCase().replace(/^\$/, ""));
const roundUrl = (env: AlertEnv, round: string) => (env.SITE_URL ? `${env.SITE_URL}/#/round/${round}` : "");
const stockUrl = (env: AlertEnv, ticker: string) => (env.SITE_URL ? `${env.SITE_URL}/s/${ticker}` : "");
const tickers = dep.demoStocks.map((d) => d.ticker).join(", ");

/** What followers are told when a round reaches `state`. */
export function announce(env: AlertEnv, r: Latest, now = Math.floor(Date.now() / 1000)): string {
  const url = roundUrl(env, r.round);
  const line = [
    `${r.symbol}: a new round opened. Pledge test USDC to bring ${r.ticker} onto Base (testnet).`,
    `${r.symbol}: the round is full. Its auction starts at the next summoning, ${summoningLabel(nextSummoning(now))}.`,
    `${r.symbol}: the auction is running. The round fills once the spread covers a filler.`,
    `${r.symbol} was summoned: the round filled and the stock trades in its backers' Uniswap v4 pool. Backers can claim now.`,
    `${r.symbol}: the round expired without a fill. Backers can take their refund.`,
  ][r.state];
  return [line ?? `${r.symbol}: the round changed.`, url].filter(Boolean).join("\n");
}

const HELP = `Summon tells you when a demo stock's round on Base Sepolia (testnet, no real value) opens, fills up, goes to auction, is summoned or expires.

/follow TICKER  follow a stock (${tickers})
/unfollow TICKER
/list  what you follow
/stop  forget this chat

Only this chat's id and the tickers it follows are kept. Summon is not offered in the United States.`;

/** Telegram's webhook. Its answer is the reply, sent back as a sendMessage in the response body. */
export async function telegram(req: Request, env: AlertEnv): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Alerts are not set up." }, 503);
  if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "forbidden" }, 403);
  const u = (await req.json().catch(() => ({}))) as { message?: { chat?: { id?: number; type?: string }; text?: string } };
  const chat = u.message?.chat?.id;
  const text = u.message?.text?.trim();
  // only private chats: a group would make its members' follows one list, and a bot added to a channel gets no say
  if (typeof chat !== "number" || !text || u.message?.chat?.type !== "private") return new Response(null, { status: 200 });
  const reply = (t: string) => json({ method: "sendMessage", chat_id: chat, text: t, link_preview_options: { is_disabled: true } });
  const [cmd = "", arg = ""] = text.split(/\s+/);
  const name = cmd.toLowerCase().replace(/@.*$/, "");
  const store = alerts(env);

  if (name === "/start" || name === "/follow") {
    if (!arg) return reply(HELP);
    const d = demoFor(arg);
    if (!d) return reply(`${arg.toUpperCase()} has no testnet round. Demo stocks: ${tickers}.`);
    const r = await store<{ error?: string }>("/follow", { chat, ticker: d.ticker });
    if (r.error) return reply(r.error);
    const now = await latestRound(d).catch(() => undefined);
    const where = now ? `\n\nRight now: ${announce(env, now)}` : `\n\n${d.symbol} has no round yet.${stockUrl(env, d.ticker) ? `\n${stockUrl(env, d.ticker)}` : ""}`;
    return reply(`Following ${d.symbol}. You'll hear when its round changes, and 15 minutes before a summoning that starts its auction. /unfollow ${d.ticker} to stop.${where}`);
  }
  if (name === "/unfollow") {
    const d = arg ? demoFor(arg) : undefined;
    if (!d) return reply(`Which one? /unfollow TICKER (${tickers})`);
    await store("/unfollow", { chat, ticker: d.ticker });
    return reply(`No more alerts for ${d.symbol}.`);
  }
  if (name === "/list") {
    const r = await store<{ tickers: string[] }>("/list", { chat });
    return reply(r.tickers.length ? `You follow ${r.tickers.join(", ")}.` : `You follow nothing yet. /follow TICKER (${tickers})`);
  }
  if (name === "/stop") {
    await store("/stop", { chat });
    return reply("Done: this chat follows nothing and nothing about it is kept. /start to come back.");
  }
  return reply(HELP);
}

/** The bot's username for the page, or 503 when alerts are off. */
export function alertsInfo(env: AlertEnv): Response {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_NAME ? json({ bot: env.TELEGRAM_BOT_NAME }) : json({ error: "Alerts are not set up." }, 503);
}

async function send(env: AlertEnv, chat: number, text: string, f: typeof fetch): Promise<number> {
  const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, link_preview_options: { is_disabled: true } }),
  });
  return r.status;
}

/** The cron tick: queue round changes and the coming summoning's reminders, then send what is queued. */
export async function tick(env: AlertEnv, f: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<{ sent: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0 };
  const store = alerts(env);
  // a stock whose read failed is left out this tick, so it is neither announced nor marked seen
  const rounds = (await Promise.all(dep.demoStocks.map((d) => latestRound(d, f).catch(() => undefined)))).filter((r): r is Latest => !!r);
  await store("/changes", { rounds: rounds.map((r) => ({ ...r, text: announce(env, r, now) })) });
  const next = nextSummoning(now);
  const funded = rounds.filter((r) => r.state === 1);
  if (funded.length && next > now && next - now <= REMIND_SECONDS) {
    const text = (r: Latest) => [`Summoning at ${summoningLabel(next)}, in ${Math.ceil((next - now) / 60)} min: ${r.symbol}'s auction starts then.`, roundUrl(env, r.round)].filter(Boolean).join("\n");
    await store("/remind", { window: next, funded: funded.map((r) => ({ ...r, text: text(r) })) });
  }
  let sent = 0;
  const again: { chat: number; text: string }[] = [];
  for (const m of await store<{ chat: number; text: string }[]>("/take", { limit: SEND_PER_TICK })) {
    const status = await send(env, m.chat, m.text, f).catch(() => 0);
    if (status === 200) sent++;
    // the person blocked the bot or deleted the chat: forget it
    else if (status === 403) await store("/stop", { chat: m.chat });
    // rate-limited or Telegram unreachable: next tick
    else if (status === 429 || status === 0 || status >= 500) again.push(m);
  }
  if (again.length) await store("/again", { messages: again });
  return { sent };
}
