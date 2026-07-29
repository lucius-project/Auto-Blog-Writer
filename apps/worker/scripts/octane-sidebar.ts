import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("text=Your Site", { timeout: 30000 });
await page.waitForTimeout(3000);
const els = await page.locator(":text-is('Articles')").evaluateAll((list) =>
  list.map((el: any) => ({
    tag: el.tagName, cls: el.className, href: el.getAttribute("href"),
    outer: el.outerHTML.slice(0, 250),
    parentOuter: el.parentElement ? el.parentElement.outerHTML.slice(0, 300) : null,
  })));
console.log(JSON.stringify(els, null, 1));
await ctx.close();
