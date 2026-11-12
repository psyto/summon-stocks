/**
 * Share a stock: a post on X or a cast on Farcaster, linking /s/TICKER, whose preview shows the stock's
 * card and its live numbers. Nothing about the wallet goes in the link.
 */
import { h } from "./el";

export const shareUrl = (ticker: string) => `${location.origin}/s/${encodeURIComponent(ticker)}`;

export function shareLinks(ticker: string, text: string): HTMLElement {
  const url = shareUrl(ticker);
  const x = `https://x.com/intent/post?${new URLSearchParams({ text, url })}`;
  const fc = `https://farcaster.xyz/~/compose?${new URLSearchParams({ text, "embeds[]": url })}`;
  const copy = h("button", { class: "share__copy", type: "button" }, "Copy link");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = url;
    }
  });
  return h(
    "p",
    { class: "share" },
    h("span", { class: "share__label" }, "Share"),
    h("a", { href: x, target: "_blank", rel: "noopener" }, "X"),
    h("a", { href: fc, target: "_blank", rel: "noopener" }, "Farcaster"),
    copy,
  );
}
