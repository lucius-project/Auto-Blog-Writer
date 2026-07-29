import { chromium } from "playwright";
import path from "node:path";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma.js";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const failed = JSON.parse(readFileSync("/tmp/failed.json", "utf8"));
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
async function clickHard(loc: any) { try { await loc.click({ timeout: 8000 }); } catch { await loc.evaluate("el => el.click()"); } }

async function findPageBySearch(title: string): Promise<string | null> {
  await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("text=Your Site", { timeout: 30000 });
  const search = page.locator('input[placeholder*="Search"]').first();
  await search.fill(title.slice(0, 40));
  await page.waitForTimeout(2500);
  const hit = page.getByText(title.slice(0, 40), { exact: false }).last();
  if (!(await hit.isVisible().catch(() => false))) return null;
  await clickHard(hit);
  try {
    await page.waitForURL(/octane\.site\/page\/\d+/, { timeout: 15000 });
    return page.url().match(/page\/(\d+)/)![1];
  } catch { return null; }
}

async function saveSeo(pageId: string, post: any) {
  const cleanTitle = String(post.seo.metaTitle).replace(/\s*\|\s*911 IT\s*$/i, "");
  return page.evaluate(`(async () => {
    const pid = ${JSON.stringify(pageId)};
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
}

async function setPublish(post: any) {
  await page.evaluate("document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight");
  await page.waitForSelector("text=PUBLISH STATUS", { timeout: 20000 });
  const sel = page.locator("select").filter({ has: page.locator("option", { hasText: "Unpublished" }) }).first();
  await sel.selectOption({ label: "Published / Scheduled" });
  await page.waitForTimeout(600);
  const dt = page.locator('input[type="datetime-local"]').first();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(post.scheduledFor));
  const g = (t: string) => fmt.find((x) => x.type === t)?.value ?? "";
  await dt.fill(`${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`);
  await page.waitForTimeout(500);
  const save = page.getByText("Save All Changes").first();
  if (await save.isVisible().catch(() => false)) { await clickHard(save); await page.waitForTimeout(3000); }
}

const toEnqueue: string[] = [];
for (const post of failed) {
  console.log(`--- ${post.title.slice(0, 50)} (step: ${post.step})`);
  if (post.step === "create-page") { toEnqueue.push(post.id); console.log("   page never created -> clean re-run"); continue; }
  const pageId = await findPageBySearch(post.title);
  if (!pageId) { console.log("   SEARCH FAILED — leaving for manual"); continue; }
  console.log("   found page", pageId);
  await page.waitForTimeout(2000);
  if (post.step === "fill-html") {
    await clickHard(page.getByText("Add A Section").first());
    await page.locator("input.layout-livesearch:visible").last().fill("full width", { timeout: 15000 });
    await page.waitForTimeout(800);
    await clickHard(page.getByText("FULL WIDTH CONTENT").first());
    await clickHard(page.getByText("Create Section").first());
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
    await page.goto(`https://octane.site/page/${pageId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  }
  console.log("   seo:", await saveSeo(pageId, post));
  await setPublish(post);
  await prisma.blogPost.update({
    where: { id: post.id },
    data: { status: "published", publishedUrl: `https://www.911it.com/blog/${post.slug}`, publishedAt: post.scheduledFor, qa: { recovered: true, publish: { externalId: pageId } } },
  });
  console.log("   RECOVERED, scheduled", post.scheduledFor);
}
if (toEnqueue.length) {
  const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63790", { maxRetriesPerRequest: null });
  const q = new Queue("publish-blog", { connection });
  for (const id of toEnqueue) await q.add("publish-blog", { blogPostId: id });
  await q.close(); await connection.quit();
  console.log("enqueued clean runs:", toEnqueue.length);
}
await ctx.close(); await prisma.$disconnect();
console.log("DONE");
process.exit(0);
