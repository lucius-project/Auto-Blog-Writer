import { chromium } from "playwright";
import path from "node:path";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";

const failed = JSON.parse(readFileSync("/tmp/failed.json", "utf8"));
const plan = [
  { titleFrag: "How to Compare IT Support", pageId: "2151898", sectionId: null, fillContent: false },
  { titleFrag: "In-House IT", pageId: "2151910", sectionId: "2151911", fillContent: true },
];
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
async function clickHard(loc: any) { try { await loc.click({ timeout: 8000 }); } catch { await loc.evaluate("el => el.click()"); } }

for (const item of plan) {
  const post = failed.find((f: any) => f.title.startsWith(item.titleFrag.slice(0, 10)));
  if (!post) { console.log("no post for", item.titleFrag); continue; }
  console.log("---", post.title.slice(0, 50));
  if (item.fillContent && item.sectionId) {
    await page.goto(`https://octane.site/page/${item.sectionId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await clickHard(page.getByText("SHOW HTML").first());
    await page.waitForTimeout(800);
    const boxes = page.locator("textarea:visible");
    let contentBox = boxes.first();
    for (let i = 0; i < await boxes.count(); i++) {
      const bb = await boxes.nth(i).boundingBox();
      if (bb && bb.height > 60) { contentBox = boxes.nth(i); break; }
    }
    await contentBox.fill(post.bodyHtml);
    await clickHard(page.getByText("Save All Changes").first());
    await page.waitForTimeout(3000);
    console.log("   content filled");
  }
  await page.goto(`https://octane.site/page/${item.pageId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  const cleanTitle = String(post.seo.metaTitle).replace(/\s*\|\s*911 IT\s*$/i, "");
  const seoRes = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify(item.pageId)};
    const html = await fetch("/page/" + pid + "/tags").then((r) => r.text());
    const token = (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1] || (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const fd = new URLSearchParams();
    fd.set("_token", token); fd.set("pageid", pid);
    fd.set("titletag", ${JSON.stringify(cleanTitle)});
    fd.set("metadesc", ${JSON.stringify(String(post.seo.metaDescription))});
    fd.set("noindex", "0"); fd.set("pagelang", ""); fd.set("bypasscache", "0");
    const a = await fetch("/page/" + pid + "/seo", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    const b = await fetch("/page/" + pid + "/schema/update", { method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ schema: ${JSON.stringify(post.seo.jsonLd)}, pageschemamode: "add" }) });
    return a.status + "/" + b.status;
  })()`);
  console.log("   seo:", seoRes);
  await page.evaluate("document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight");
  await page.waitForSelector("text=PUBLISH STATUS", { timeout: 20000 });
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Unpublished" }) }).first();
  await sel.selectOption({ label: "Published / Scheduled" });
  await page.waitForTimeout(600);
  const dt = page.locator('input[type="datetime-local"]').first();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(post.scheduledFor));
  const g = (t: string) => fmt.find((x: any) => x.type === t)?.value ?? "";
  await dt.fill(`${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`);
  await page.waitForTimeout(500);
  const save = page.getByText("Save All Changes").first();
  if (await save.isVisible().catch(() => false)) { await clickHard(save); await page.waitForTimeout(3000); }
  await prisma.blogPost.update({
    where: { id: post.id },
    data: { status: "published", publishedUrl: `https://www.911it.com/blog/${post.slug}`, publishedAt: new Date(post.scheduledFor), qa: { recovered: true, publish: { externalId: item.pageId } } },
  });
  console.log("   PUBLISHED/SCHEDULED for", post.scheduledFor);
}
await ctx.close(); await prisma.$disconnect();
console.log("ALL DONE");
process.exit(0);
