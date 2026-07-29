import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3000);
const get = await page.evaluate(`fetch("/page/2151890/tags").then(r => r.text())`);
console.log("GET /tags:", String(get).slice(0, 500));
const csrf = await page.evaluate(`(document.querySelector('meta[name="csrf-token"]') || {}).content || ""`);
console.log("csrf present:", Boolean(csrf));
const post = await page.evaluate(`fetch("/page/2151890/tags/update", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": (document.querySelector('meta[name="csrf-token"]')||{}).content || "", "X-Requested-With": "XMLHttpRequest" },
  body: JSON.stringify({ titletag: "What Happens If You Fail HIPAA Compliance? | 911 IT", metadesc: "HIPAA violations trigger OCR investigations, fines from $100 to $50,000 per violation, and mandatory corrective action plans. Learn the penalties and prevention." })
}).then(r => r.status + " " + r.url).catch(e => "ERR " + e.message)`);
console.log("POST /tags/update:", post);
const get2 = await page.evaluate(`fetch("/page/2151890/tags").then(r => r.text())`);
console.log("GET /tags after:", String(get2).slice(0, 400));
await ctx.close();
