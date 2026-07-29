import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "POST" && u.includes("octane.site") && !u.includes("websockets")) {
    console.log("POST", u.replace("https://octane.site", ""), "|", String(req.postData()).slice(0, 400));
  }
});
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate("el => el.click()"); }
await page.waitForSelector("text=META DESCRIPTION", { timeout: 15000 });
const desc = page.locator("textarea[name=metadesc]");
await desc.click();
await desc.pressSequentially("HIPAA violations trigger OCR investigations and fines from $100 to $50,000 per violation. Learn the real penalties and prevention steps.", { delay: 3 });
await page.keyboard.press("Tab");
await page.waitForTimeout(800);
await page.keyboard.press("Escape");
await page.waitForTimeout(1500);
const saveAll = page.locator("button.edit-page-save-btn");
console.log("saveAll visible:", await saveAll.isVisible().catch(() => false));
try { await saveAll.click({ timeout: 6000 }); } catch (e) { console.log("normal click failed, js"); await saveAll.evaluate("el => el.click()"); }
await page.waitForTimeout(5000);
console.log("--- done; rechecking saved value ---");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const seoTab2 = page.getByText("SEO", { exact: true }).first();
try { await seoTab2.click({ timeout: 8000 }); } catch { await seoTab2.evaluate("el => el.click()"); }
await page.waitForSelector("text=META DESCRIPTION", { timeout: 15000 });
console.log("metadesc after reload:", JSON.stringify((await page.locator("textarea[name=metadesc]").inputValue()).slice(0, 60)));
await ctx.close();
