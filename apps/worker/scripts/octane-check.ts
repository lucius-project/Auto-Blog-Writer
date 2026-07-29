import { chromium } from "playwright";
import path from "node:path";
const pageId = process.argv[2];
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto(`https://octane.site/page/${pageId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);
const text = await page.locator("body").innerText().catch(() => "");
const idx = text.indexOf("PUBLISHER");
console.log("PUBLISHER SECTION:", text.slice(idx, idx + 400).replace(/\n+/g, " | "));
const selects = page.locator("select");
for (let i = 0; i < await selects.count(); i++) {
  const val = await selects.nth(i).inputValue().catch(() => "?");
  const opts = await selects.nth(i).locator("option").allInnerTexts().catch(() => []);
  if (opts.some((o) => /publish/i.test(o))) console.log(`select[${i}] value="${val}" options=`, opts);
}
const dt = page.locator('input[type="datetime-local"]').first();
if (await dt.count()) console.log("publish date value:", await dt.inputValue().catch(() => "?"));
await page.screenshot({ path: "/tmp/octane-pubstate.png" });
await ctx.close();
