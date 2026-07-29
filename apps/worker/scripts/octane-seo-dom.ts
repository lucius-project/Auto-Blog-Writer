import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3500);
const seoTab = page.getByText("SEO", { exact: true }).first();
try { await seoTab.click({ timeout: 8000 }); } catch { await seoTab.evaluate("el => el.click()"); }
await page.waitForSelector("text=META DESCRIPTION", { timeout: 15000 });
const fields = await page.evaluate(`(() => {
  const out = [];
  const els = Array.from(document.querySelectorAll("input, textarea, select"));
  for (const el of els) {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    if (/seo|meta|title|description|schema|noindex/i.test(JSON.stringify(attrs))) out.push({ tag: el.tagName, attrs });
  }
  return out.slice(0, 14);
})()`);
console.log(JSON.stringify(fields, null, 1).slice(0, 3000));
const controls = await page.evaluate(`(() => Array.from(document.querySelectorAll("a,button"))
  .filter((el) => /save|apply/i.test(el.textContent || "") && el.offsetParent !== null)
  .map((el) => ({ tag: el.tagName, text: (el.textContent || "").trim().slice(0, 30), cls: el.className,
    data: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.indexOf("data-") === 0).map((a) => [a.name, a.value])) })))()`);
console.log("CONTROLS:", JSON.stringify(controls, null, 1).slice(0, 1500));
await ctx.close();
