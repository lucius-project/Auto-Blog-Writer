// Give published posts that went out without a cartoon (image generation
// failed at publish time, e.g. OpenRouter out of credit) their featured image.
// Only touches the CMS post's featured_media; skips posts that already have one.
//   npx tsx scripts/backfill-images.ts [--dry-run]
import { prisma } from "../src/lib/prisma.js";
import { ensureCartoon, publisherFor } from "../src/processors/publishBlog.js";

const dryRun = process.argv.includes("--dry-run");
const posts = await prisma.blogPost.findMany({ where: { status: "published" }, orderBy: { publishedAt: "desc" } });
const missing = posts.filter((p) => !(p.seo as any)?.cartoon && (p.qa as any)?.publish?.externalId);
console.log(`${missing.length} published posts without a recorded cartoon`);

for (const post of missing) {
  const externalId: string = (post.qa as any).publish.externalId;
  const target = await prisma.publishTarget.findFirst({ where: { companyId: post.companyId, isDefault: true } });
  if (target?.kind !== "wordpress") { console.log(`skip ${post.id}: target is ${target?.kind ?? "none"}`); continue; }
  const cfg = target.config as any;
  const publisher = publisherFor(target);

  // already has a featured image in WordPress (set outside this app, or before cartoons were recorded)
  const { decryptSecret } = await import("../src/lib/secrets.js");
  const auth = "Basic " + Buffer.from(`${cfg.username}:${decryptSecret(String(cfg.appPassword ?? ""))}`).toString("base64");
  const wp = await fetch(`${String(cfg.baseUrl).replace(/\/$/, "")}/wp-json/wp/v2/posts/${externalId}?context=edit&_fields=featured_media`, { headers: { Authorization: auth } })
    .then((r) => r.json() as Promise<any>);
  if (wp?.featured_media) { console.log(`skip "${post.title}": already has featured image ${wp.featured_media}`); continue; }

  if (dryRun) { console.log(`would add image: "${post.title}"`); continue; }
  try {
    const img = await ensureCartoon(post);
    const r = await publisher.setFeaturedImage!(externalId, { slug: post.slug, previewImage: img });
    console.log(`${r.ok ? "added" : "FAILED"} "${post.title}"${r.ok ? ` (media ${r.mediaId})` : `: ${r.detail}`}`);
  } catch (e: any) {
    console.log(`FAILED "${post.title}": ${e?.message}`);
  }
}
await prisma.$disconnect();
