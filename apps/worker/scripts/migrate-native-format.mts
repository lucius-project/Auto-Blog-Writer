/**
 * One-time migration (2026-07-21): convert every automated Octane article to
 * the native article format the owner edits manually —
 *   1. generate + upload the funny cartoon (preview + hero image)
 *   2. write bodyHtml into the article's NATIVE content field (+ excerpt)
 *   3. delete the bolted-on "Full Width Content" section (content lived there
 *      before, invisible to the normal editor and rendering above the header)
 * Publish state/schedule is NOT touched.
 */
import { chromium } from "playwright";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { generateCartoon } from "../src/lib/imagegen.js";
import { uploadImage, saveNativeContent } from "../src/publishers/octane.js";

const prisma = new PrismaClient();
const posts = await prisma.blogPost.findMany({ where: { status: "published" }, orderBy: { createdAt: "asc" } });
const targets = posts.filter((p) => ((p.qa as any) ?? {}).publish?.externalId);
console.log(`migrating ${targets.length}/${posts.length} published posts`);

const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
if (page.url().includes("/login")) throw new Error("octane session expired");

const pageTitle = async (id: string) => {
  return await page.evaluate(`fetch("/page/${id}").then(r => r.text()).then(t => (t.match(/<title>([^<]*)<\\/title>/) || [])[1] || "")`) as string;
};

const results: string[] = [];
for (const post of targets) {
  const extId = String(((post.qa as any).publish.externalId));
  const seo = (post.seo ?? {}) as any;
  const tag = `${post.title.slice(0, 45)} (${extId})`;
  try {
    // 1. cartoon
    const imgDir = path.resolve("data/images"); mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, `${post.id}.png`);
    let meta = seo.cartoon;
    if (!existsSync(imgPath) || !meta?.width) {
      const vertical = post.verticalId ? await prisma.vertical.findUnique({ where: { id: post.verticalId } }) : null;
      const img = await generateCartoon({ companyId: post.companyId, title: post.title, vertical: vertical?.name, blogPostId: post.id });
      writeFileSync(imgPath, img.buffer);
      meta = { alt: img.alt, width: img.width, height: img.height, gag: img.gag };
      await prisma.blogPost.update({ where: { id: post.id }, data: { seo: { ...seo, cartoon: meta } } });
    }
    const filename = await uploadImage(page, imgPath, `blog-${post.slug.slice(0, 40)}.png`);

    // 2. native content
    await saveNativeContent(page, extId, {
      title: post.title, slug: post.slug, bodyHtml: post.bodyHtml,
      metaTitle: seo.metaTitle ?? post.title, metaDescription: seo.metaDescription ?? "",
      jsonLd: seo.jsonLd ?? {}, scheduledFor: null,
      previewImage: { filePath: imgPath, alt: meta.alt, width: meta.width, height: meta.height },
    }, filename);

    // 3. delete the FWC section (id is article+1 from the create flow; verify before deleting)
    const secId = String(Number(extId) + 1);
    const t = await pageTitle(secId);
    let secNote = "no FWC section found";
    if (/Editing: Full Width Content/.test(t)) {
      const del = await page.evaluate(`(async () => {
        const html = await fetch("/page/${secId}").then(r => r.text());
        const token = (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1] || (document.querySelector('meta[name="csrf-token"]') || {}).content;
        const fd = new URLSearchParams();
        fd.set("_token", token); fd.set("_method", "DELETE");
        const res = await fetch("/page/${secId}", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
        return String(res.status);
      })()`);
      const after = await pageTitle(secId);
      if (!/Editing: Full Width Content/.test(String(after))) {
        secNote = `section ${secId} deleted (${del})`;
      } else {
        // fallback: blank the section so nothing renders twice
        await saveNativeContent(page, secId, { title: "", slug: post.slug, bodyHtml: "<p></p>", metaTitle: "", metaDescription: "", jsonLd: {}, scheduledFor: null, previewImage: null }, null).catch(() => null);
        secNote = `section ${secId} DELETE failed (${del}) — blanked instead`;
      }
    }
    // article still alive?
    const artT = await pageTitle(extId);
    if (!artT.includes("Editing:")) throw new Error("article page missing after migration!");
    await prisma.blogPost.update({ where: { id: post.id }, data: { qa: { ...(post.qa as any), publish: { ...(post.qa as any).publish, migratedNativeAt: new Date().toISOString() } } } });
    results.push(`OK   ${tag} | img ${filename} | ${secNote}`);
    console.log(results[results.length - 1]);
  } catch (e: any) {
    results.push(`FAIL ${tag} | ${String(e?.message ?? e).slice(0, 150)}`);
    console.log(results[results.length - 1]);
  }
}
console.log("\n===== SUMMARY =====");
console.log(results.join("\n"));
console.log(`done: ${results.filter(r => r.startsWith("OK")).length} ok, ${results.filter(r => r.startsWith("FAIL")).length} failed`);
await ctx.close();
await prisma.$disconnect();
