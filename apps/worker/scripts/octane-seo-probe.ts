import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
page.on("request", (req) => {
  if (req.method() === "POST" && req.url().includes("octane.site")) {
    console.log("POST", req.url().replace("https://octane.site", ""), "|", String(req.postData()).slice(0, 300));
  }
});
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate((el: any) => el.click()); }
await page.waitForSelector("text=META DESCRIPTION", { timeout: 15000 });
const desc = page.getByText("META DESCRIPTION").locator("xpath=following::textarea[1]");
await desc.click();
await desc.pressSequentially("HIPAA violations trigger OCR investigations, fines from $100 to $50,000 per violation, and mandatory corrective action plans.", { delay: 5 });
await page.keyboard.press("Tab");
console.log("--- typed desc, waiting for save traffic ---");
await page.waitForTimeout(4000);
// check if a save-all button appeared
const saveAll = page.getByText("Save All Changes").first();
if (await saveAll.isVisible().catch(() => false)) {
  console.log("--- clicking Save All Changes ---");
  try { await saveAll.click({ timeout: 6000 }); } catch { await saveAll.evaluate((el: any) => el.click()); }
  await page.waitForTimeout(4000);
}
// also look for a save button inside the modal
const modalSave = page.locator("button:visible, a:visible").filter({ hasText: /^Save$/ });
console.log("visible Save buttons:", await modalSave.count());
await ctx.close();
