import type { Job } from "bullmq";
import { PublishBlogPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { octanePublisher } from "../publishers/octane.js";
import { wordpressPublisher } from "../publishers/wordpress.js";
import type { Publisher } from "../publishers/types.js";
import { fetchText } from "../lib/site.js";
import { decryptSecret } from "../lib/secrets.js";
import { notify } from "../lib/notify.js";
import { generateCartoon } from "../lib/imagegen.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 5 — Publishing. Only `approved` posts publish. Pushes through the
 * tenant's PublishTarget adapter, then verifies the page is actually live
 * (or scheduled) before marking published. Idempotent: an already-published
 * post is a no-op (double-enqueue safe). A post previously pushed to the CMS
 * (qa.publish.externalId) updates the SAME page instead of creating a new one.
 */
export async function publishBlog(job: Job) {
  const payload = PublishBlogPayload.parse(job.data);
  const post = await prisma.blogPost.findUniqueOrThrow({ where: { id: payload.blogPostId } });
  if (post.status === "published") {
    console.log(`[publish-blog] ${post.id} already published — no-op`);
    return { status: "noop", blogPostId: post.id, liveUrl: post.publishedUrl };
  }
  if (post.status !== "approved") {
    throw new Error(`post ${post.id} is '${post.status}', only 'approved' posts publish`);
  }
  const target = payload.publishTargetId
    ? await prisma.publishTarget.findUniqueOrThrow({ where: { id: payload.publishTargetId } })
    : await prisma.publishTarget.findFirstOrThrow({ where: { companyId: post.companyId, isDefault: true } });

  const cfg = target.config as any;
  let publisher: Publisher;
  if (target.kind === "custom" && cfg.adapter === "octane") {
    publisher = octanePublisher({ profileDir: cfg.profileDir ?? "secrets/octane-profile" });
  } else if (target.kind === "wordpress") {
    publisher = wordpressPublisher({ ...cfg, appPassword: decryptSecret(String(cfg.appPassword ?? "")) });
  } else {
    throw new Error(`no adapter for publish target kind=${target.kind} adapter=${cfg.adapter ?? "?"}`);
  }

  const seo = (post.seo ?? {}) as any;

  // every article gets a funny cartoon (generated once, reused on retries)
  let previewImage: { filePath: string; alt: string; width: number; height: number } | null = null;
  try {
    const imgDir = path.resolve("data/images");
    mkdirSync(imgDir, { recursive: true });
    const imgPath = path.join(imgDir, `${post.id}.jpg`);
    if (existsSync(imgPath) && seo.cartoon?.width) {
      previewImage = { filePath: imgPath, alt: seo.cartoon.alt ?? `Cartoon: ${post.title}`, width: seo.cartoon.width, height: seo.cartoon.height };
    } else {
      const vertical = post.verticalId ? await prisma.vertical.findUnique({ where: { id: post.verticalId } }) : null;
      const img = await generateCartoon({ companyId: post.companyId, title: post.title, vertical: vertical?.name, blogPostId: post.id });
      writeFileSync(imgPath, img.buffer);
      previewImage = { filePath: imgPath, alt: img.alt, width: img.width, height: img.height };
      await prisma.blogPost.update({
        where: { id: post.id },
        data: { seo: { ...seo, cartoon: { alt: img.alt, width: img.width, height: img.height, gag: img.gag } } },
      });
    }
  } catch (e: any) {
    console.warn(`[publish-blog] cartoon generation failed (publishing without image): ${e?.message}`);
  }

  const article = {
    title: post.title,
    slug: post.slug,
    bodyHtml: post.bodyHtml,
    metaTitle: seo.metaTitle ?? post.title,
    metaDescription: seo.metaDescription ?? "",
    jsonLd: seo.jsonLd ?? {},
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    previewImage,
  };

  // rewrite of an already-pushed page -> update in place when the adapter can
  const priorExternalId: string | undefined = ((post.qa as any) ?? {}).publish?.externalId;
  const result = priorExternalId && publisher.update
    ? await publisher.update(priorExternalId, article)
    : await publisher.publish(article);

  if (!result.ok) {
    await prisma.blogPost.update({
      where: { id: post.id },
      data: { status: "failed", publishError: result.detail ?? "unknown publish error", qa: { ...(post.qa as any ?? {}), publishError: result.detail } },
    });
    await notify({
      companyId: post.companyId,
      type: "publish_failed",
      title: `Publish failed: ${post.title.slice(0, 80)}`,
      body: (result.detail ?? "").slice(0, 200),
      href: `/company/${post.companyId}`,
    });
    throw new Error(`publish failed: ${result.detail}`);
  }

  // verify-after-publish (immediate publishes only; scheduled ones verify later)
  let verified = false;
  const isBackfillOrNow = !post.scheduledFor || post.scheduledFor <= new Date();
  if (isBackfillOrNow && result.liveUrl) {
    try {
      const res = await fetchText(result.liveUrl);
      const stillThere = new URL(res.finalUrl).pathname.length > 1; // homepage redirect = not live
      verified = res.status === 200 && stillThere && res.text.includes(post.title.slice(0, 40));
    } catch { verified = false; }
  }

  await prisma.blogPost.update({
    where: { id: post.id },
    data: {
      status: "published",
      publishedUrl: result.liveUrl,
      publishedAt: post.scheduledFor ?? new Date(),
      publishError: null,
      qa: { ...(post.qa as any ?? {}), publish: { externalId: result.externalId, verified, at: new Date().toISOString() } },
    },
  });
  if (post.topicNodeId) {
    await prisma.topicNode.update({ where: { id: post.topicNodeId }, data: { status: "answered_strong" } });
  }
  console.log(`[publish-blog] "${post.title}" -> ${result.liveUrl} (verified=${verified})`);
  return { status: "ok", blogPostId: post.id, liveUrl: result.liveUrl, verified };
}
