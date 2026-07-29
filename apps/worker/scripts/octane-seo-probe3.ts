import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
page.on("request", (req) => {
  const u = req.url();
  if (req.method() === "POST" && u.includes("octane.site") && !u.includes("websockets")) {
    console.log("POST", u.replace("https://octane.site", ""), "|", String(req.postData()).slice(0, 300));
  }
});
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate("el => el.click()"); }
await page.waitForSelector("text=META DESCRIPTION", { timeout: 15000 });
const desc = page.locator("textarea[name=metadesc]");
await desc.click();
await desc.pressSequentially("HIPAA violations trigger OCR investigations and fines from $100 to $50,000 per violation. Learn the real penalties and prevention.", { delay: 3 });
const title = page.locator("input[name=titletag]");
await title.click();
await title.press("Control+a");
await title.pressSequentially("What Happens If You Fail HIPAA Compliance? | 911 IT", { delay: 3 });
console.log("--- closing modal with X ---");
const closeBtn = page.locator(".close, [class*=close]").last();
try { await closeBtn.click({ timeout: 4000 }); } catch { await page.keyboard.press("Escape"); }
await page.waitForTimeout(4000);
console.log("--- done ---");
await ctx.close();
