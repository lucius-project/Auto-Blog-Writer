import { chromium } from "playwright";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const posts = await prisma.blogPost.findMany({ where: { status: "published" } });
const targets = posts.filter((p) => ((p.qa as any) ?? {}).publish?.externalId);
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), { headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
for (const post of targets) {
  const sid = String(Number((post.qa as any).publish.externalId) + 1);
  const out = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify("SID")};
    const html = await fetch("/page/" + pid).then(r => r.text());
    const title = (html.match(/<title>([^<]*)</) || [])[1] || "";
    if (!/Full Width Content/.test(title)) return "skip (" + title.slice(0, 40) + ")";
    const grab = (n) => (html.match(new RegExp('name="' + n + '"[^>]*value="([^"]*)"')) || html.match(new RegExp('value="([^"]*)"[^>]*name="' + n + '"')) || [])[1] || "";
    const fd = new URLSearchParams();
    fd.set("_token", grab("_token"));
    fd.set("_method", "PUT");
    fd.set("siteid", grab("siteid") || "2418");
    fd.set("published", "no");
    fd.set("publishdate", "");
    fd.set("featured", grab("featured") || "0");
    fd.set("custom1", grab("custom1"));
    fd.set("whichupdate", "publish");
    const res = await fetch("/page/" + pid, { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    return "unpublished " + res.status;
  })()`.replace(JSON.stringify("SID"), JSON.stringify(sid))).catch((e: any) => "ERR " + String(e?.message).slice(0, 50));
  console.log(`${post.title.slice(0, 48)} | section ${sid}: ${out}`);
}
await ctx.close();
await prisma.$disconnect();
