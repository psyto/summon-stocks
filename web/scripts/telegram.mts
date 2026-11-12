/**
 * Points the alerts bot at the deployed Worker and sets its commands. Run once after deploying (and again
 * if the site's address or the webhook secret changes):
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… SITE_URL=https://… npm run telegram
 *
 * Values not in the environment are read from .dev.vars. The same token and secret must be the Worker's
 * secrets (wrangler secret put TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET).
 */
import { existsSync, readFileSync } from "node:fs";

const file = new URL("../.dev.vars", import.meta.url);
const vars = Object.fromEntries(
  (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split("\n")
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!.replace(/^"(.*)"$/, "$1")]),
);
const get = (k: string) => process.env[k] ?? vars[k];
const token = get("TELEGRAM_BOT_TOKEN");
const secret = get("TELEGRAM_WEBHOOK_SECRET");
const site = get("SITE_URL")?.replace(/\/$/, "");
if (!token || !secret || !site) throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and SITE_URL.");
if (!site.startsWith("https://")) throw new Error("Telegram calls webhooks over HTTPS only: SITE_URL must be the deployed site.");

async function api(method: string, body: unknown) {
  const r = (await (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { ok: boolean; description?: string; result?: unknown };
  if (!r.ok) throw new Error(`${method}: ${r.description}`);
  return r.result;
}

await api("setWebhook", { url: `${site}/api/telegram`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
await api("setMyCommands", {
  commands: [
    { command: "follow", description: "Follow a demo stock's round: /follow RDDT" },
    { command: "unfollow", description: "Stop following one" },
    { command: "list", description: "What this chat follows" },
    { command: "stop", description: "Forget this chat" },
  ],
});
await api("setMyShortDescription", { short_description: "Alerts when a Summon round on Base Sepolia (testnet) opens, fills up, goes to auction or is summoned." });
const me = (await api("getMe", {})) as { username: string };
console.log(`@${me.username} now posts to ${site}/api/telegram. Set TELEGRAM_BOT_NAME = "${me.username}" and SITE_URL = "${site}" under [vars] in wrangler.toml, and deploy.`);
