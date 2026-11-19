/**
 * Starts the summon workflow (.github/workflows/summon.yml) ahead of each summoning. GitHub's own schedule
 * is no clock: on 2026-11-19 the 12:30 UTC wake-up started at 21:41, after the window had closed. The
 * Worker's cron runs every minute, so 15 and again 10 minutes before the summoning it asks GitHub to run the
 * workflow, which waits for 10:00 New York itself. A second dispatch, or GitHub's late schedule, is harmless:
 * the workflow's runs queue one at a time, and e2e (SCHEDULED=1) summons nothing once a round has filled
 * in the last 12 hours, outside the window, or on an exchange holiday.
 *
 * Off until GITHUB_DISPATCH_TOKEN is set: a fine-grained token for the one repository, Actions read and write.
 */
import { nextSummoning } from "../../ts/schedule";

export interface DispatchEnv {
  /** secret: the token; var: "owner/repo" */
  GITHUB_DISPATCH_TOKEN?: string;
  SUMMON_REPO?: string;
}

/** Minutes before the summoning at which the workflow is dispatched. */
export const DISPATCH_AT_MINUTES = [15, 10] as const;

/** Dispatches the workflow when a dispatch minute has come; returns GitHub's status, or undefined if none was due. */
export async function dispatchSummon(env: DispatchEnv, f: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<number | undefined> {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.SUMMON_REPO) return undefined;
  const next = nextSummoning(now);
  if (next <= now || !(DISPATCH_AT_MINUTES as readonly number[]).includes(Math.ceil((next - now) / 60))) return undefined;
  const r = await f(`https://api.github.com/repos/${env.SUMMON_REPO}/actions/workflows/summon.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "summon-worker",
    },
    body: JSON.stringify({ ref: "main", inputs: { now: "false" } }),
  });
  if (r.status !== 204) console.log(`summon dispatch: GitHub answered ${r.status}`, await r.text().catch(() => ""));
  return r.status;
}
