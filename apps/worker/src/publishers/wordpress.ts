import type { Publisher, PublishArticle, PublishResult } from "./types.js";

/**
 * WordPress adapter — REST API with application-password auth.
 * config: { baseUrl, username, appPassword, defaultCategoryId? }
 * Native scheduling via status=future + date. JSON-LD is embedded at the top
 * of content inside a script tag (works on any theme; swap for a head
 * injection plugin like Rank Math when the tenant has one).
 */
async function wpUploadMedia(baseUrl: string, auth: string, a: PublishArticle): Promise<number | null> {
  if (!a.previewImage) return null;
  try {
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(a.previewImage.filePath);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "image/jpeg",
        "Content-Disposition": `attachment; filename="blog-${a.slug.slice(0, 40)}.jpg"`,
      },
      body: new Uint8Array(buf),
    });
    if (!res.ok) {
      console.warn(`[wordpress publisher] media upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as any;
    // set alt text
    await fetch(`${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/media/${data.id}`, {
      method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: a.previewImage.alt }),
    }).catch(() => null);
    return data.id ?? null;
  } catch (e: any) {
    console.warn(`[wordpress publisher] media upload threw: ${e?.message}`);
    return null;
  }
}

export function wordpressPublisher(config: {
  baseUrl: string; username: string; appPassword: string; defaultCategoryId?: number;
}): Publisher {
  return {
    kind: "wordpress",
    async publish(a: PublishArticle): Promise<PublishResult> {
      const auth = "Basic " + Buffer.from(`${config.username}:${config.appPassword}`).toString("base64");
      const mediaId = await wpUploadMedia(config.baseUrl, auth, a);
      const schedule = a.scheduledFor && new Date(a.scheduledFor) > new Date();
      const body = {
        title: a.title,
        slug: a.slug,
        content: `<script type="application/ld+json">${JSON.stringify(a.jsonLd)}</script>\n${a.bodyHtml}`,
        excerpt: a.metaDescription,
        status: schedule ? "future" : "publish",
        // past scheduledFor = backfill: publish now carrying the past date
        ...(a.scheduledFor ? { date: a.scheduledFor } : {}),
        ...(config.defaultCategoryId ? { categories: [config.defaultCategoryId] } : {}),
        ...(mediaId ? { featured_media: mediaId } : {}),
      };
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, detail: `wordpress ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const data = (await res.json()) as any;
      return { ok: true, liveUrl: data.link, externalId: String(data.id) };
    },
    async update(externalId: string, a: PublishArticle): Promise<PublishResult> {
      const auth = "Basic " + Buffer.from(`${config.username}:${config.appPassword}`).toString("base64");
      const schedule = a.scheduledFor && new Date(a.scheduledFor) > new Date();
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/posts/${externalId}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: a.title,
          content: `<script type="application/ld+json">${JSON.stringify(a.jsonLd)}</script>\n${a.bodyHtml}`,
          excerpt: a.metaDescription,
          status: schedule ? "future" : "publish",
          ...(a.scheduledFor ? { date: a.scheduledFor } : {}),
        }),
      });
      if (!res.ok) return { ok: false, detail: `wordpress update ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const data = (await res.json()) as any;
      return { ok: true, liveUrl: data.link, externalId: String(data.id) };
    },
  };
}
