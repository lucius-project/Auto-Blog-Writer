// Apply full SEO (meta + complete JSON-LD graph) to already-live articles via API
import { chromium } from "playwright";
import path from "node:path";
import { readFileSync } from "node:fs";
const posts = JSON.parse(readFileSync("/tmp/live-seo.json", "utf8"));
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
for (const post of posts) {
  const pid = post.pageId ?? (post.title.includes("HIPAA") ? "2151890" : null);
  if (!pid) { console.log("SKIP (no pageId):", post.title.slice(0, 40)); continue; }
  const cleanTitle = String(post.seo.metaTitle).replace(/\s*\|\s*911 IT\s*$/i, "");
  const script = `(async () => {
    const pid = ${JSON.stringify(String(pid))};
    const html = await fetch("/page/" + pid + "/tags").then((r) => r.text());
    const token = (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1] || (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const fd = new URLSearchParams();
    fd.set("_token", token); fd.set("pageid", pid);
    fd.set("titletag", ${JSON.stringify(cleanTitle)});
    fd.set("metadesc", ${JSON.stringify(String(post.seo.metaDescription))});
    fd.set("noindex", "0"); fd.set("pagelang", ""); fd.set("bypasscache", "0");
    const a = await fetch("/page/" + pid + "/seo", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    const b = await fetch("/page/" + pid + "/schema/update", { method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ schema: ${JSON.stringify(post.seo.jsonLd)}, pageschemamode: "add" }) });
    return a.status + "/" + b.status;
  })()`;
  const res = await page.evaluate(script);
  console.log(pid, post.title.slice(0, 45), "->", res);
}
await ctx.close();
