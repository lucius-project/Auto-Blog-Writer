import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
const out = await page.evaluate(`(async () => {
  const results = [];
  for (let id = 2151890; id <= 2151935; id++) {
    try {
      const r = await fetch("/page/" + id, { headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) continue;
      const t = await r.text();
      const m = t.match(/<title>([^<]*)<\\/title>/);
      if (m && /Editing/.test(m[1])) results.push(id + " :: " + m[1].replace("Octane Editing: ", "").slice(0, 60));
    } catch (e) { /* skip */ }
  }
  return results;
})()`);
console.log((out as string[]).join("\n"));
await ctx.close();
