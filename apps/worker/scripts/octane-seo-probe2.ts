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
// type into metadesc with real events
const desc = page.locator("textarea[name=metadesc]");
await desc.click();
await desc.pressSequentially("HIPAA violations trigger OCR investigations and fines from $100 to $50,000 per violation. Learn the penalties and how to prevent them.", { delay: 3 });
// switch to schema tab (may commit metadesc via vue watch)
const schemaTab = page.getByText("Schema", { exact: true }).first();
try { await schemaTab.click({ timeout: 8000 }); } catch { await schemaTab.evaluate("el => el.click()"); }
await page.waitForTimeout(1000);
const schemaBox = page.locator("textarea[name=schema]");
await schemaBox.click();
await schemaBox.pressSequentially('{"@context":"https://schema.org"}', { delay: 3 });
await page.waitForTimeout(500);
// look for save controls INSIDE the modal now
const saves = await page.evaluate(`(() => Array.from(document.querySelectorAll("a,button,input[type=submit],.btn"))
  .filter((el) => /save/i.test((el.textContent||el.value||"")) && el.offsetParent !== null)
  .map((el) => ({ tag: el.tagName, text: (el.textContent||el.value||"").trim(), cls: String(el.className).slice(0,60) })))()`);
console.log("SAVE CONTROLS NOW:", JSON.stringify(saves));
for (const sel of ["button:has-text('Save')", ".btn:has-text('Save')", "a:has-text('Save')"]) {
  const b = page.locator(sel).last();
  if (await b.isVisible().catch(() => false)) {
    console.log("clicking", sel);
    try { await b.click({ timeout: 4000 }); } catch { await b.evaluate("el => el.click()"); }
    await page.waitForTimeout(3000);
    break;
  }
}
await page.waitForTimeout(3000);
console.log("--- done ---");
await ctx.close();
