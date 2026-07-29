import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("text=Your Site", { timeout: 30000 });
const catId = await page.getByText("Articles", { exact: true }).first().evaluate("el => el.closest('li').getAttribute('data-cat')");
await page.evaluate(`location.hash = "#${catId}"`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const body = await page.locator("body").innerText();
for (const frag of ["In-House", "Compare IT Support", "Practice Management Software", "OSHA", "Backup and Disaster Recovery Cost", "Choose an IT Provider"]) {
  const count = body.split(frag).length - 1;
  console.log(`"${frag}" appears ${count}x in articles list`);
}
await ctx.close();
