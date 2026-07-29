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
  const pid = String((post.qa as any).publish.externalId);
  const out = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify("PID")};
    const html = await fetch("/page/" + pid).then(r => r.text());
    const grab = (n) => (html.match(new RegExp('name="' + n + '"[^>]*value="([^"]*)"')) || html.match(new RegExp('value="([^"]*)"[^>]*name="' + n + '"')) || [])[1] || "";
    const fd = new URLSearchParams();
    fd.set("_token", grab("_token"));
    fd.set("_method", "PUT");
    fd.set("siteid", grab("siteid") || "2418");
    fd.set("published", "yes");
    fd.set("publishdate", grab("publishdate"));
    fd.set("featured", grab("featured") || "0");
    fd.set("custom1", grab("custom1"));
    fd.set("whichupdate", "publish");
    const res = await fetch("/page/" + pid, { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    return res.status + "@" + grab("publishdate");
  })()`.replace(JSON.stringify("PID"), JSON.stringify(pid))).catch((e: any) => "ERR " + e.message.slice(0, 60));
  console.log(`${String(out).startsWith("200") ? "OK  " : "FAIL"} ${post.title.slice(0, 50)} (${pid}) ${out}`);
}
await ctx.close();
await prisma.$disconnect();
