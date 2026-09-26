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

/**
 * Point the Article/BlogPosting node's canonical fields at the real permalink
 * the CMS just gave us. At generation time we only have a best-effort guess
 * (permalink structures vary: /blog/, /YYYY/MM/DD/, bare slug), so the mismatch
 * is fixed here once the true URL is known.
 */
function withCanonicalUrl(jsonLd: unknown, liveUrl: string): unknown {
  if (!jsonLd || typeof jsonLd !== "object" || !liveUrl) return jsonLd;
  const clone = JSON.parse(JSON.stringify(jsonLd));
  const nodes: any[] = Array.isArray(clone["@graph"]) ? clone["@graph"] : [clone];
  for (const n of nodes) {
    const types = Array.isArray(n?.["@type"]) ? n["@type"] : [n?.["@type"]];
    if (types.some((t: string) => t === "BlogPosting" || t === "Article" || t === "NewsArticle")) {
      n.url = liveUrl;
      n.mainEntityOfPage = { "@type": "WebPage", "@id": liveUrl };
    }
  }
  return clone;
}

/**
 * The post's real permalink. For a scheduled (status=future) post WordPress
 * returns `link` as the placeholder `/?p=<id>`, which 404s until go-live and
 * has pathname "/" — so build the eventual permalink from the edit-context
 * `permalink_template` + `generated_slug` instead.
 */
function permalinkOf(data: any): string {
  const link: string = data?.link ?? "";
  if (!/[?&]p=\d+/.test(link)) return link;
  const template: string | undefined = data?.permalink_template;
  const slug: string | undefined = data?.generated_slug || data?.slug;
  if (!template || !slug || !/%(postname|pagename)%/.test(template)) return link;
  return template.replace(/%(postname|pagename)%/, slug);
}

const ldScript = (jsonLd: unknown, bodyHtml: string) =>
  `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n${bodyHtml}`;

export function wordpressPublisher(config: {
  baseUrl: string; username: string; appPassword: string; defaultCategoryId?: number;
}): Publisher {
  const base = config.baseUrl.replace(/\/$/, "");
  const auth = "Basic " + Buffer.from(`${config.username}:${config.appPassword}`).toString("base64");

  /** Re-save the post's content with JSON-LD pointing at the real permalink. */
  const fixCanonical = async (postId: string | number, a: PublishArticle, liveUrl: string) => {
    if (!a.jsonLd || !Object.keys(a.jsonLd as object).length || !liveUrl) return;
    try {
      const r = await fetch(`${base}/wp-json/wp/v2/posts/${postId}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ content: ldScript(withCanonicalUrl(a.jsonLd, liveUrl), a.bodyHtml) }),
      });
      if (!r.ok) console.warn(`[wordpress publisher] JSON-LD canonical fixup ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e: any) {
      console.warn(`[wordpress publisher] JSON-LD canonical fixup threw: ${e?.message}`);
    }
  };

  return {
    kind: "wordpress",
    async publish(a: PublishArticle): Promise<PublishResult> {
      const mediaId = await wpUploadMedia(base, auth, a);
      const schedule = a.scheduledFor && new Date(a.scheduledFor) > new Date();
      const body = {
        title: a.title,
        slug: a.slug,
        content: ldScript(a.jsonLd, a.bodyHtml),
        excerpt: a.metaDescription,
        status: schedule ? "future" : "publish",
        // past scheduledFor = backfill: publish now carrying the past date
        ...(a.scheduledFor ? { date: a.scheduledFor } : {}),
        ...(config.defaultCategoryId ? { categories: [config.defaultCategoryId] } : {}),
        ...(mediaId ? { featured_media: mediaId } : {}),
      };
      const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, detail: `wordpress ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const data = (await res.json()) as any;
      const liveUrl = permalinkOf(data);
      await fixCanonical(data.id, a, liveUrl);
      return { ok: true, liveUrl, externalId: String(data.id) };
    },
    async update(externalId: string, a: PublishArticle): Promise<PublishResult> {
      const schedule = a.scheduledFor && new Date(a.scheduledFor) > new Date();
      const res = await fetch(`${base}/wp-json/wp/v2/posts/${externalId}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: a.title,
          content: ldScript(a.jsonLd, a.bodyHtml),
          excerpt: a.metaDescription,
          status: schedule ? "future" : "publish",
          ...(a.scheduledFor ? { date: a.scheduledFor } : {}),
        }),
      });
      if (!res.ok) return { ok: false, detail: `wordpress update ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const data = (await res.json()) as any;
      const liveUrl = permalinkOf(data);
      await fixCanonical(externalId, a, liveUrl);
      return { ok: true, liveUrl, externalId: String(data.id) };
    },
    async resolveLive(externalId: string, a: PublishArticle): Promise<PublishResult & { live: boolean }> {
      const res = await fetch(`${base}/wp-json/wp/v2/posts/${externalId}?context=edit`, { headers: { Authorization: auth } });
      if (!res.ok) return { ok: false, live: false, detail: `wordpress get ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const data = (await res.json()) as any;
      if (data.status !== "publish") return { ok: true, live: false, externalId, detail: `status=${data.status}` };
      await fixCanonical(externalId, a, data.link);
      return { ok: true, live: true, liveUrl: data.link, externalId };
    },
  };
}
