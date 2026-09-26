import type { Job } from "bullmq";
import { VerifyPublishedPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { publisherFor, verifyLive } from "./publishBlog.js";

/** stop re-checking a post this long after its go-live (deleted/unpublished in the CMS) */
const GIVE_UP_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Scheduled posts are pushed to the CMS before they go live, so publish-blog
 * can't verify them and may only get a placeholder URL (WordPress: /?p=<id>).
 * Once scheduledFor has passed, ask the CMS for the real permalink, re-point
 * the JSON-LD canonical at it, store it, and verify the page actually serves.
 */
export async function verifyPublished(job: Job) {
  const payload = VerifyPublishedPayload.parse(job.data ?? {});
  const now = new Date();
  const posts = await prisma.blogPost.findMany({
    where: {
      ...(payload.companyId ? { companyId: payload.companyId } : {}),
      status: "published",
      publishedAt: { lte: now, gte: new Date(now.getTime() - GIVE_UP_AFTER_MS) },
    },
  });
  const pending = posts.filter((p) => (p.qa as any)?.publish?.verified !== true);

  let fixed = 0, verifiedCount = 0;
  for (const post of pending) {
    const qa = (post.qa as any) ?? {};
    const externalId: string | undefined = qa.publish?.externalId;
    let liveUrl = post.publishedUrl;
    let resolvedAt: string | undefined = qa.publish?.resolvedAt;

    // resolve once: resolveLive re-saves the CMS page, so don't repeat it for a post that only fails verification
    const target = resolvedAt ? null : await prisma.publishTarget.findFirst({ where: { companyId: post.companyId, isDefault: true } });
    if (target && externalId) {
      try {
        const publisher = publisherFor(target);
        if (publisher.resolveLive) {
          const seo = (post.seo ?? {}) as any;
          const r = await publisher.resolveLive(externalId, {
            title: post.title,
            slug: post.slug,
            bodyHtml: post.bodyHtml,
            metaTitle: seo.metaTitle ?? post.title,
            metaDescription: seo.metaDescription ?? "",
            jsonLd: seo.jsonLd ?? {},
            scheduledFor: post.scheduledFor?.toISOString() ?? null,
          });
          if (!r.ok) { console.warn(`[verify-published] ${post.id}: ${r.detail}`); continue; }
          if (!r.live) continue; // CMS hasn't flipped it live yet — next sweep
          if (r.liveUrl) liveUrl = r.liveUrl;
          resolvedAt = now.toISOString();
        }
      } catch (e: any) {
        console.warn(`[verify-published] ${post.id}: ${e?.message}`);
        continue;
      }
    }
    if (!liveUrl) continue;

    const verified = await verifyLive(liveUrl, post.title);
    await prisma.blogPost.update({
      where: { id: post.id },
      data: {
        publishedUrl: liveUrl,
        qa: { ...qa, publish: { ...qa.publish, verified, resolvedAt, checkedAt: now.toISOString() } },
      },
    });
    if (liveUrl !== post.publishedUrl) {
      fixed++;
      console.log(`[verify-published] "${post.title}" ${post.publishedUrl} -> ${liveUrl}`);
    }
    if (verified) verifiedCount++;
    else console.warn(`[verify-published] "${post.title}" not serving at ${liveUrl}`);
  }
  return { checked: pending.length, fixed, verified: verifiedCount };
}
