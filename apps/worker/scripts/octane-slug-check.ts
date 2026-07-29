import { chromium } from "playwright";
import path from "node:path";
import { readFileSync } from "node:fs";
const failed = JSON.parse(readFileSync("/tmp/failed.json", "utf8"));
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
const slugs = [...failed.map((f: any) => f.slug), "osha-data-requirements-audit-it-preparation-guide"];
for (const slug of slugs) {
  const res = await page.evaluate(`(async () => {
    const token = (document.querySelector('meta[name="csrf-token"]')||{}).content;
    const fd = new URLSearchParams(); fd.set("url", "blog/" + ${JSON.stringify(slug)}); fd.set("_token", token);
    const r = await fetch("/url/check", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": token }, body: fd });
    return r.status + " :: " + (await r.text()).slice(0, 120);
  })()`);
  console.log(slug.slice(0, 50), "->", res);
}
await ctx.close();
