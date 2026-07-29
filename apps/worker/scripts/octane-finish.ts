// Finish publishing the already-created article page: find it, set status + date, save.
import { chromium } from "playwright";
import path from "node:path";
const slugFrag = "what-happens-if-healthcare";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("text=Your Site", { timeout: 30000 });
const catId = await page.getByText("Articles", { exact: true }).first().evaluate((el: any) => el.closest("li")?.getAttribute("data-cat") ?? "");
await page.evaluate((h) => { (globalThis as any).location.hash = h; }, `#${catId}`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const id = await page.evaluate((frag) => {
  const doc = (globalThis as any).document;
  const anchors = Array.from(doc.querySelectorAll("a")) as any[];
  for (const a of anchors) {
    const row = a.closest("tr, li, .row, [class*=page-item], div");
    if (!row || !(row.textContent ?? "").includes(frag)) continue;
    const scope = row.parentElement ?? row;
    const pageLink = scope.querySelector("a[href*='/page/']") ?? row.querySelector("a[href*='/page/']");
    if (pageLink) { const m = pageLink.getAttribute("href").match(/page\/(\d+)/); if (m) return m[1]; }
    const opener = row.querySelector("[data-page-id], [data-id]");
    if (opener) return opener.getAttribute("data-page-id") ?? opener.getAttribute("data-id");
  }
  return null;
}, slugFrag);
if (!id) { console.log("NOT FOUND"); process.exit(1); }
console.log("article page id:", id);
await page.goto(`https://octane.site/page/${id}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
await page.evaluate(() => { const d = (globalThis as any).document; if (d?.scrollingElement) d.scrollingElement.scrollTop = d.scrollingElement.scrollHeight; });
await page.waitForSelector("text=PUBLISH STATUS", { timeout: 20000 });
const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Unpublished" }) }).first();
const opts = await sel.locator("option").allInnerTexts();
console.log("status options:", opts);
const target2 = opts.find((o) => /publish|live/i.test(o) && !/unpublish/i.test(o)) ?? opts[opts.length - 1];
await sel.selectOption({ label: target2 });
await page.waitForTimeout(800);
const now = page.getByText("Now", { exact: true }).first();
try { await now.click({ timeout: 5000 }); } catch { await now.evaluate((el: any) => el.click()).catch(() => {}); }
await page.waitForTimeout(800);
const save = page.getByText("Save All Changes").first();
try { await save.click({ timeout: 6000 }); } catch { await save.evaluate((el: any) => el.click()); }
await page.waitForTimeout(3500);
console.log("published with status:", target2);
await ctx.close();
