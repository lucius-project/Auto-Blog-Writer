import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
// 1. restore the wrongly re-dated article to its original 2026-08-24 schedule
await page.goto("https://octane.site/page/2131993", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
await page.evaluate(() => { const d = (globalThis as any).document; d.scrollingElement.scrollTop = d.scrollingElement.scrollHeight; });
await page.waitForSelector("text=PUBLISH STATUS", { timeout: 20000 });
const dt = page.locator('input[type="datetime-local"]').first();
await dt.fill("2026-08-24T09:00");
await page.waitForTimeout(800);
const save = page.getByText("Save All Changes").first();
try { await save.click({ timeout: 6000 }); } catch { await save.evaluate((el: any) => el.click()); }
await page.waitForTimeout(3000);
console.log("restored 2131993 ->", await dt.inputValue());

// 2. open OUR article by clicking its exact title in the Articles list
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Your Site", { timeout: 30000 });
const catId = await page.getByText("Articles", { exact: true }).first().evaluate((el: any) => el.closest("li")?.getAttribute("data-cat") ?? "");
await page.evaluate((h) => { (globalThis as any).location.hash = h; }, `#${catId}`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const title = page.getByText("What Happens If a Healthcare & Dental Business Fails HIPAA Compliance?").first();
try { await title.click({ timeout: 8000 }); } catch { await title.evaluate((el: any) => el.click()); }
await page.waitForURL(/octane\.site\/page\/\d+/, { timeout: 20000 });
const ourId = page.url().match(/page\/(\d+)/)![1];
console.log("our article page id:", ourId);
await page.waitForTimeout(3000);
const urlText = await page.locator("body").innerText();
const i = urlText.indexOf("PAGE URL");
console.log("PAGE URL:", urlText.slice(i, i + 140).replace(/\n+/g, " "));

// 3. publish it now
await page.evaluate(() => { const d = (globalThis as any).document; d.scrollingElement.scrollTop = d.scrollingElement.scrollHeight; });
await page.waitForSelector("text=PUBLISH STATUS", { timeout: 20000 });
const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Unpublished" }) }).first();
await sel.selectOption({ label: "Published / Scheduled" });
await page.waitForTimeout(600);
const now = page.getByText("Now", { exact: true }).first();
try { await now.click({ timeout: 5000 }); } catch { await now.evaluate((el: any) => el.click()); }
await page.waitForTimeout(600);
const dt2 = page.locator('input[type="datetime-local"]').first();
console.log("publish date set to:", await dt2.inputValue());
const save2 = page.getByText("Save All Changes").first();
try { await save2.click({ timeout: 6000 }); } catch { await save2.evaluate((el: any) => el.click()); }
await page.waitForTimeout(3500);
console.log("published");
await ctx.close();
