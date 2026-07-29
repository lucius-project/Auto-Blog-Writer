import { chromium } from "playwright";
import path from "node:path";
import { readFileSync } from "node:fs";
const { metaTitle, metaDescription, jsonLd } = JSON.parse(readFileSync("/tmp/seo-payload.json", "utf8"));
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate((el: any) => el.click()); }
await page.waitForSelector("text=HTML TITLE TAG", { timeout: 15000 });
const titleInput = page.getByText("HTML TITLE TAG").locator("xpath=following::input[1]");
await titleInput.fill(metaTitle);
await titleInput.press("Tab");
const descBox = page.getByText("META DESCRIPTION").locator("xpath=following::textarea[1]");
await descBox.fill(metaDescription);
await descBox.press("Tab");
await page.waitForTimeout(1500);
const schemaTab = page.getByText("Schema", { exact: true }).first();
try { await schemaTab.click({ timeout: 8000 }); } catch { await schemaTab.evaluate((el: any) => el.click()); }
await page.getByPlaceholder(/seo schema/i).fill(JSON.stringify(jsonLd, null, 1));
await page.waitForTimeout(500);
const saveBtn = page.getByText("Save", { exact: true }).last();
try { await saveBtn.click({ timeout: 8000 }); } catch { await saveBtn.evaluate((el: any) => el.click()); }
await page.waitForTimeout(2000);
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
const saveAll = page.getByText("Save All Changes").first();
if (await saveAll.isVisible().catch(() => false)) {
  try { await saveAll.click({ timeout: 6000 }); } catch { await saveAll.evaluate((el: any) => el.click()); }
  await page.waitForTimeout(3000);
}
console.log("seo + schema saved");
await ctx.close();
