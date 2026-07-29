import { chromium } from "playwright";
import path from "node:path";

const ids = ["2151885", "2151886", "2151888"];
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
for (const id of ids) {
  await page.goto(`https://octane.site/page/${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);
  try {
    const hidden = page.getByText("HIDDEN", { exact: false }).first();
    try { await hidden.click({ timeout: 6000 }); } catch { await hidden.evaluate((el: any) => el.click()); }
    await page.waitForTimeout(1000);
    const save = page.getByText("Save All Changes").first();
    if (await save.isVisible().catch(() => false)) {
      try { await save.click({ timeout: 6000 }); } catch { await save.evaluate((el: any) => el.click()); }
      await page.waitForTimeout(2500);
    }
    console.log(`page ${id}: set HIDDEN`);
  } catch (e: any) {
    console.log(`page ${id}: FAILED - ${e?.message?.slice(0, 120)}`);
  }
}
await ctx.close();
