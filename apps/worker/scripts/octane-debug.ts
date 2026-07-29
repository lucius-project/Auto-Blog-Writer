import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000);
console.log("URL:", page.url());
console.log("TITLE:", await page.title());
await page.screenshot({ path: "/tmp/octane-debug.png", fullPage: false });
const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 1200);
console.log("BODY TEXT:", text.replace(/\n+/g, " | "));
await ctx.close();
