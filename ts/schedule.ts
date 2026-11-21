/**
 * Summoning days: funded rounds have their auctions started at a set time, so backers know when to come
 * back and watch theirs fill. Shared by the keeper (which starts auctions only in the window) and the page
 * (which says when the next one is). Testnet: Tuesdays and Thursdays at 10:00 New York time, 15 minutes
 * after the open, when fills are allowed. An exchange holiday (from market-state's calendar) is not a
 * summoning day, so the page and the reminders skip it; the round would refuse to start then anyway.
 */
import { regularSession } from "@fabrknt/market-state";

export const SUMMON_DAYS = [2, 4] as const; // Tuesday, Thursday (New York weekday, Sunday = 0)
export const SUMMON_AT = { hour: 10, minute: 0 } as const; // New York time
/** How long after the hour the keeper still starts auctions (the auction itself then runs 60 min). */
export const SUMMON_WINDOW_SECONDS = 30 * 60;

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });

/** The New York calendar fields of an instant. */
function ny(t: number) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!) };
}

/** Unix seconds of a New York wall-clock time (EST or EDT, whichever applies that day). */
function nyInstant(y: number, m: number, d: number, h: number, min: number): number {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, h + off, min) / 1000;
    const f = ny(t);
    if (f.h === h && f.min === min && f.d === d) return t;
  }
  return Date.UTC(y, m - 1, d, h + 5, min) / 1000;
}

/** Whether the market is in its core session at a summoning's start: false on an exchange holiday. */
const tradingAt = (t: number) => regularSession(t, true).open;

/** The summoning window containing `now`, or undefined. */
export function inSummoning(now: number): { start: number; end: number } | undefined {
  const f = ny(now);
  if (!(SUMMON_DAYS as readonly number[]).includes(f.wd)) return undefined;
  const start = nyInstant(f.y, f.m, f.d, SUMMON_AT.hour, SUMMON_AT.minute);
  if (!tradingAt(start)) return undefined;
  return now >= start && now < start + SUMMON_WINDOW_SECONDS ? { start, end: start + SUMMON_WINDOW_SECONDS } : undefined;
}

/** The start of the next summoning window at or after `now` (the current one if it is open). */
export function nextSummoning(now: number): number {
  const open = inSummoning(now);
  if (open) return open.start;
  for (let i = 0; i < 15; i++) {
    const f = ny(now + i * 86_400);
    if (!(SUMMON_DAYS as readonly number[]).includes(f.wd)) continue;
    const start = nyInstant(f.y, f.m, f.d, SUMMON_AT.hour, SUMMON_AT.minute);
    if (start >= now && tradingAt(start)) return start;
  }
  return now;
}

/** "Tue Nov 18, 10:00 ET", for the page and the keeper's notes. */
export function summoningLabel(t: number): string {
  const f = ny(t);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(t * 1000));
  return `${day}, ${String(f.h).padStart(2, "0")}:${String(f.min).padStart(2, "0")} ET`;
}
