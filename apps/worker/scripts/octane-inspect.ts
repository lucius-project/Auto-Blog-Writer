import { chromium } from "playwright";
import path from "node:path";
const id = process.argv[2] ?? "2131993";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto(`https://octane.site/page/${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const body = await page.locator("body").innerText();
const grab = (label: string, len = 220) => {
  const i = body.indexOf(label);
  return i >= 0 ? body.slice(i, i + len).replace(/\n+/g, " | ") : "(not found)";
};
console.log("TITLE:", await page.title());
console.log("PAGE URL:", grab("PAGE URL", 160));
console.log("PUBLISHER:", grab("PUBLISH STATUS", 260));
const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Unpublished" }) }).first();
if (await sel.count()) console.log("status value:", await sel.inputValue(), "| selected label:", await sel.locator("option:checked").innerText().catch(() => "?"));
const dt = page.locator('input[type="datetime-local"]').first();
if (await dt.count()) console.log("publish date:", await dt.inputValue());
await page.screenshot({ path: "/tmp/octane-inspect.png", fullPage: true });
await ctx.close();
