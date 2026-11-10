/**
 * IntentStore: the one Durable Object that holds every signed intent (Codex r2 #3, #9).
 *
 * A Durable Object runs one request at a time, and its SQLite calls are synchronous, so each write checks
 * the nonce, the per-network limits and stores the intent with nothing in between: two requests can no
 * longer both pass a check that only one should.
 *
 * Bounded (Codex r3 #3, r4 #3): totals are kept as one row per stock, keyed by its token address (a
 * ticker can change, Codex r4 #4), so the board reads at most one row per stock. They are returned by
 * token; the Worker names them from the current snapshot. Every request first deletes the intents that have expired (through the expiry index, so it reads
 * only those) and takes them off the totals, so an expired intent stops counting at once. Live intents are
 * capped at MAX_LIVE. A nonce is the signing time in ms and an intent may last at most MAX_EXPIRY_DAYS from
 * it, so a stored nonce is dropped MAX_EXPIRY_DAYS after it: any older signature has expired by then. Stored
 * nonces are also capped at MAX_NONCES; past it, a wallet new to a stock is refused until old ones expire.
 * The demand export reads each page when it is fetched: an intent stored during an export, before the
 * cursor, shows in the next export.
 *
 * The Worker checks the signature and the snapshot first; this object only sees intents that verify.
 */

/** The part of ctx.storage this object uses; tests pass a node:sqlite stand-in. */
export interface Storage {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

export interface Put {
  ticker: string;
  token: string; // checksummed
  address: string; // lowercase
  usd: number;
  expiry: number;
  nonce: number;
  signature: string;
  ip: string;
}

/** Per IP: intent writes per hour, and new wallets per day (a cheap brake on one person signing from
 * many wallets; the board still says it counts wallets, not people). */
export const WRITES_PER_HOUR = 20;
export const NEW_WALLETS_PER_DAY = 5;
const DEMAND_PAGE = 500;
export const MAX_LIVE = 50_000;
export const MAX_EXPIRY_DAYS = 31;
export const MAX_NONCES = 200_000;
const SWEEP_MS = 3_600_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class IntentStore {
  private sql: Storage["sql"];

  constructor(
    private ctx: { storage: Storage },
    _env?: unknown,
  ) {
    this.sql = ctx.storage.sql;
    // token and address are lowercase; the stored token keeps its checksum in `token_cs` for the export
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intents (token TEXT NOT NULL, address TEXT NOT NULL, ticker TEXT NOT NULL,
      token_cs TEXT NOT NULL, usd INTEGER NOT NULL, expiry INTEGER NOT NULL, nonce INTEGER NOT NULL, signature TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY (token, address))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS intents_expiry ON intents (expiry)`);
    // the highest nonce each wallet used for each stock, kept after its intent expires or is replaced
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (token TEXT NOT NULL, address TEXT NOT NULL, nonce INTEGER NOT NULL,
      PRIMARY KEY (token, address))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS nonces_nonce ON nonces (nonce)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS totals (token TEXT PRIMARY KEY, ticker TEXT NOT NULL, backers INTEGER NOT NULL, usd INTEGER NOT NULL)`);
    // counts kept alongside their tables, so a cap is one row read
    this.sql.exec(`CREATE TABLE IF NOT EXISTS counts (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS writes (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wallets (ip TEXT NOT NULL, day INTEGER NOT NULL, address TEXT NOT NULL,
      PRIMARY KEY (ip, day, address))`);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.sweep(Date.now());
    if (url.pathname === "/put" && req.method === "POST") {
      const r = this.put((await req.json()) as Put);
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
      return r;
    }
    if (url.pathname === "/totals") return json(this.totals());
    if (url.pathname === "/demand") return json(this.demand(url.searchParams.get("token") ?? undefined, url.searchParams.get("after") ?? undefined));
    return json({ error: "not found" }, 404);
  }

  /** Every check and write for one intent, with no await between them. */
  private put(p: Put): Response {
    const now = Date.now();
    const token = p.token.toLowerCase();
    const last = this.sql.exec(`SELECT nonce FROM nonces WHERE token = ? AND address = ?`, token, p.address).toArray()[0]?.nonce as number | undefined;
    if (last !== undefined && p.nonce <= last) {
      return json({ error: "This signature is older than one already used for this stock. Sign a new intent." }, 409);
    }

    const hour = Math.floor(now / 3_600_000);
    const day = Math.floor(now / 86_400_000);
    const writes = (this.sql.exec(`SELECT n FROM writes WHERE ip = ? AND hour = ?`, p.ip, hour).toArray()[0]?.n as number | undefined) ?? 0;
    if (writes >= WRITES_PER_HOUR) {
      return json({ error: `Too many intents from this network this hour. Try again after ${new Date((hour + 1) * 3_600_000).toISOString().slice(11, 16)} UTC.` }, 429);
    }
    if (last === undefined && this.count("nonces") >= MAX_NONCES) {
      return json({ error: "The board is remembering as many signatures as it can right now. Try again later." }, 503);
    }
    const prev = this.sql.exec(`SELECT usd FROM intents WHERE token = ? AND address = ?`, token, p.address).toArray()[0]?.usd as number | undefined;
    const isNew = prev === undefined;
    if (isNew) {
      const live = (this.sql.exec(`SELECT COALESCE(SUM(backers), 0) AS n FROM totals`).toArray()[0]!.n as number) ?? 0;
      if (live >= MAX_LIVE) return json({ error: "The board holds as many intents as it can right now. Try again later." }, 503);
    }
    const seen = this.sql.exec(`SELECT 1 FROM wallets WHERE ip = ? AND day = ? AND address = ?`, p.ip, day, p.address).toArray().length > 0;
    if (isNew && !seen) {
      const n = this.sql.exec(`SELECT COUNT(*) AS n FROM wallets WHERE ip = ? AND day = ?`, p.ip, day).toArray()[0]!.n as number;
      if (n >= NEW_WALLETS_PER_DAY) {
        return json({ error: `This network has signed from ${NEW_WALLETS_PER_DAY} wallets today. Intents count wallets, so the limit keeps one person from looking like many.` }, 429);
      }
    }

    this.sql.exec(`INSERT INTO writes (ip, hour, n) VALUES (?, ?, 1) ON CONFLICT (ip, hour) DO UPDATE SET n = n + 1`, p.ip, hour);
    if (!seen) this.sql.exec(`INSERT INTO wallets (ip, day, address) VALUES (?, ?, ?)`, p.ip, day, p.address);
    this.sql.exec(`INSERT INTO nonces (token, address, nonce) VALUES (?, ?, ?) ON CONFLICT (token, address) DO UPDATE SET nonce = excluded.nonce`, token, p.address, p.nonce);
    if (last === undefined) this.addCount("nonces", 1);
    this.sql.exec(
      `INSERT INTO intents (token, address, ticker, token_cs, usd, expiry, nonce, signature, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (token, address) DO UPDATE SET ticker = excluded.ticker, token_cs = excluded.token_cs, usd = excluded.usd,
       expiry = excluded.expiry, nonce = excluded.nonce, signature = excluded.signature, at = excluded.at`,
      token, p.address, p.ticker, p.token, p.usd, p.expiry, p.nonce, p.signature, now,
    );
    this.sql.exec(
      `INSERT INTO totals (token, ticker, backers, usd) VALUES (?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET ticker = excluded.ticker, backers = backers + excluded.backers, usd = usd + excluded.usd`,
      token, p.ticker, isNew ? 1 : 0, p.usd - (prev ?? 0),
    );
    const row = this.sql.exec(`SELECT backers, usd FROM totals WHERE token = ?`, token).toArray()[0]!;
    return json({ ok: true, ticker: p.ticker, backers: row.backers, usd: row.usd });
  }

  /** Deletes the intents that expired before `now` (ms) and takes them off the totals; reads only those. */
  private sweep(now: number) {
    const gone = this.sql.exec(`SELECT token, COUNT(*) AS n, SUM(usd) AS usd FROM intents WHERE expiry < ? GROUP BY token`, now / 1000).toArray();
    if (gone.length === 0) return;
    for (const g of gone) this.sql.exec(`UPDATE totals SET backers = backers - ?, usd = usd - ? WHERE token = ?`, g.n, g.usd, g.token);
    this.sql.exec(`DELETE FROM intents WHERE expiry < ?`, now / 1000);
    this.sql.exec(`DELETE FROM totals WHERE backers <= 0`);
  }

  /** { [token]: { backers, usd } } over unexpired intents (the request already swept the expired ones). The
   * Worker names each token by the current snapshot, so a renamed or reassigned ticker shows at once
   * (Codex r5 #2). */
  private totals(): Record<string, { backers: number; usd: number }> {
    const t: Record<string, { backers: number; usd: number }> = {};
    for (const r of this.sql.exec(`SELECT token, backers, usd FROM totals`).toArray()) t[r.token as string] = { backers: r.backers as number, usd: r.usd as number };
    return t;
  }

  /** Unexpired intents, DEMAND_PAGE at a time, in (token, address) order; `next` continues the export. */
  private demand(token?: string, after?: string) {
    const [aToken, aAddr] = after ? after.split(":") : ["", ""];
    const rows = this.sql
      .exec(
        `SELECT ticker, token_cs AS token, address, usd, expiry, nonce, signature, token AS t FROM intents
         WHERE expiry >= ? AND (? IS NULL OR token = ?) AND (token > ? OR (token = ? AND address > ?))
         ORDER BY token, address LIMIT ?`,
        Date.now() / 1000, token ?? null, token ?? null, aToken, aToken, aAddr, DEMAND_PAGE + 1,
      )
      .toArray();
    const more = rows.length > DEMAND_PAGE;
    const page = rows.slice(0, DEMAND_PAGE);
    const lastRow = page[page.length - 1];
    return {
      intents: page.map(({ t: _, ...r }) => r),
      next: more && lastRow ? `${lastRow.t}:${lastRow.address}` : null,
    };
  }

  private count(k: string): number {
    return (this.sql.exec(`SELECT n FROM counts WHERE k = ?`, k).toArray()[0]?.n as number | undefined) ?? 0;
  }

  private addCount(k: string, d: number) {
    this.sql.exec(`INSERT INTO counts (k, n) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET n = n + excluded.n`, k, d);
  }

  /** Hourly: drop expired intents, old limit counters, and nonces old enough that every signature below them
   * has expired. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sweep(now);
    const cutoff = now - MAX_EXPIRY_DAYS * 86_400_000;
    const old = this.sql.exec(`SELECT COUNT(*) AS n FROM nonces WHERE nonce < ?`, cutoff).toArray()[0]!.n as number;
    if (old > 0) {
      this.sql.exec(`DELETE FROM nonces WHERE nonce < ?`, cutoff);
      this.addCount("nonces", -old);
    }
    this.sql.exec(`DELETE FROM writes WHERE hour < ?`, Math.floor(now / 3_600_000) - 1);
    this.sql.exec(`DELETE FROM wallets WHERE day < ?`, Math.floor(now / 86_400_000) - 1);
    const left = this.sql.exec(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM nonces LIMIT 1)`).toArray()[0]!.n as number;
    if (left > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}
