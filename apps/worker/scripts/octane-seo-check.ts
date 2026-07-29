import { chromium } from "playwright";
import path from "node:path";
const pageId = process.argv[2] ?? "2151890";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto(`https://octane.site/page/${pageId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate((el: any) => el.click()); }
await page.waitForSelector("text=HTML TITLE TAG", { timeout: 15000 });
const titleVal = await page.getByText("HTML TITLE TAG").locator("xpath=following::input[1]").inputValue();
const descVal = await page.getByText("META DESCRIPTION").locator("xpath=following::textarea[1]").inputValue();
console.log("admin title field:", JSON.stringify(titleVal));
console.log("admin desc field:", JSON.stringify(descVal.slice(0, 80)));
const schemaTab = page.getByText("Schema", { exact: true }).first();
try { await schemaTab.click({ timeout: 8000 }); } catch { await schemaTab.evaluate((el: any) => el.click()); }
await page.waitForTimeout(1500);
const schemaVal = await page.getByPlaceholder(/seo schema/i).inputValue().catch(() => "(not found)");
console.log("admin schema field:", JSON.stringify(String(schemaVal).slice(0, 100)));
await ctx.close();
