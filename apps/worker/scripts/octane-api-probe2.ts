import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
const html = await page.evaluate(`fetch("/page/2151890/tags").then(r => r.text())`);
const action = String(html).match(/action="([^"]+)"/);
console.log("FORM ACTION:", action ? action[1] : "none");
const inputs = [...String(html).matchAll(/<(input|textarea|select)[^>]*name="([^"]+)"[^>]*>/g)].map((m) => m[2]);
console.log("FORM FIELDS:", JSON.stringify([...new Set(inputs)]));
const method = String(html).match(/<form[^>]*>/);
console.log("FORM TAG:", method ? method[0] : "none");
await ctx.close();
