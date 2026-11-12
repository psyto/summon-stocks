/**
 * Share-card images for every stock: serves the built page (vite preview), screenshots #/card/TICKER at
 * 1200×630 in Chromium, and writes dist/og/TICKER.jpg, which /s/TICKER names as its og:image.
 * Run after `vite build` (npm run deploy does both).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const PORT = 4180;
const tickers = (JSON.parse(readFileSync(new URL("../dist/b20.json", import.meta.url), "utf8")) as { stocks: { ticker: string }[] }).stocks.map((s) => s.ticker);
const only = process.argv.slice(2);
const out = new URL("../dist/og/", import.meta.url);
mkdirSync(out, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await puppeteer.launch({ args: ["--lang=en-US"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630 });
  let n = 0;
  for (const t of only.length ? only : tickers) {
    await page.goto(`http://localhost:${PORT}/#/card/${t}`, { waitUntil: "networkidle0" });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".card[data-ready]");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: new URL(`${t}.jpg`, out).pathname as `${string}.jpg`, type: "jpeg", quality: 85 });
    n++;
  }
  await browser.close();
  console.log(`${n} share cards in dist/og/`);
} finally {
  server.kill();
}
