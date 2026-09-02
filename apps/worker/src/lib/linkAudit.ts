import { prisma } from "./prisma.js";
import type { PageLink } from "./site.js";

const UA = "Mozilla/5.0 (compatible; ABW-LinkCheck/1.0; +https://github.com/911it/Auto-Blog-Writer)";

/**
 * Recompute the internal link graph from stored SitePage.outboundLinks:
 * inboundInternal counts + auto-flag pillar pages. Cheap, no network.
 */
export async function computeLinkGraph(companyId: string): Promise<void> {
  const pages = await prisma.sitePage.findMany({
    where: { companyId },
    select: { id: true, url: true, path: true, contentType: true, outboundLinks: true },
  });
  const byPath = new Map<string, string>(); // normalized path -> pageId
  const normPath = (p: string) => (p || "/").split("?")[0]!.replace(/\/+$/, "") || "/";
  for (const p of pages) byPath.set(normPath(p.path), p.id);

  const inbound = new Map<string, number>();
  for (const p of pages) {
    const links = (p.outboundLinks ?? []) as unknown as PageLink[];
    const seen = new Set<string>();
    for (const l of links) {
      if (l.kind !== "internal") continue;
      const targetId = byPath.get(normPath(l.path));
      if (!targetId || targetId === p.id || seen.has(targetId)) continue;
      seen.add(targetId);
      inbound.set(targetId, (inbound.get(targetId) ?? 0) + 1);
    }
  }

  const PILLAR_TYPES = new Set(["home", "service", "industry", "location"]);
  await Promise.all(pages.map((p) => {
    const inb = inbound.get(p.id) ?? 0;
    const isPillar = p.contentType === "home" || (PILLAR_TYPES.has(p.contentType ?? "") && inb >= 3);
    return prisma.sitePage.update({ where: { id: p.id }, data: { inboundInternal: inb, isPillar } });
  }));
}

interface CheckResult { status: number | null; ok: boolean; error?: string }

async function headOrGet(url: string): Promise<CheckResult> {
  const opts = { headers: { "User-Agent": UA }, redirect: "follow" as const, signal: AbortSignal.timeout(12000) };
  try {
    let res = await fetch(url, { ...opts, method: "HEAD" });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetch(url, { ...opts, method: "GET" });
    }
    // 999 (LinkedIn), 429 (rate-limited), 403 after a GET retry = bot-blocked,
    // not actually broken — don't flag these.
    const botBlocked = res.status === 999 || res.status === 429 || res.status === 403;
    return { status: res.status, ok: res.status < 400 || botBlocked };
  } catch (e: any) {
    return { status: null, ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Check every distinct link target on the site (page links + published blog
 * internal links) for HTTP health. Fresh, still-OK external links are skipped
 * for 3 days to bound requests; internal links are always re-checked.
 */
export async function checkLinks(companyId: string, opts: { max?: number } = {}): Promise<{ checked: number; broken: number }> {
  const max = opts.max ?? 600;
  const pages = await prisma.sitePage.findMany({
    where: { companyId }, select: { url: true, path: true, outboundLinks: true },
  });
  const posts = await prisma.blogPost.findMany({
    where: { companyId, status: "published", publishedUrl: { not: null } },
    select: { publishedUrl: true, bodyHtml: true },
  });

  // target url -> { kind, sources: [{sourceUrl, sourcePath, anchor}] }
  const targets = new Map<string, { kind: "internal" | "external"; sources: { sourceUrl: string; sourcePath: string; anchor: string }[] }>();
  const add = (targetUrl: string, kind: "internal" | "external", src: { sourceUrl: string; sourcePath: string; anchor: string }) => {
    const key = targetUrl.replace(/#.*$/, "");
    const e = targets.get(key) ?? { kind, sources: [] };
    if (e.sources.length < 25) e.sources.push(src);
    targets.set(key, e);
  };
  for (const p of pages) {
    for (const l of (p.outboundLinks ?? []) as unknown as PageLink[]) {
      add(l.href, l.kind, { sourceUrl: p.url, sourcePath: p.path, anchor: l.anchor });
    }
  }
  // published blog internal links (anchors pointing at the live site)
  for (const post of posts) {
    let origin = "";
    try { origin = new URL(post.publishedUrl!).origin; } catch { /* skip */ }
    for (const m of (post.bodyHtml || "").matchAll(/href=["'](\/[^"']*)["']/g)) {
      if (!origin) break;
      const href = origin + m[1];
      add(href, "internal", { sourceUrl: post.publishedUrl!, sourcePath: new URL(post.publishedUrl!).pathname, anchor: "" });
    }
  }

  // skip external links we verified OK recently
  const recent = await prisma.linkCheck.findMany({
    where: { companyId, ok: true, kind: "external", checkedAt: { gt: new Date(Date.now() - 3 * 864e5) } },
    select: { targetUrl: true },
  });
  const skip = new Set(recent.map((r) => r.targetUrl));

  const queue = [...targets.entries()]
    .filter(([url, t]) => !(t.kind === "external" && skip.has(url)))
    .slice(0, max);

  let checked = 0, broken = 0;
  const BATCH = 8;
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = queue.slice(i, i + BATCH);
    await Promise.all(batch.map(async ([url, t]) => {
      const r = await headOrGet(url);
      checked++;
      if (!r.ok) broken++;
      await prisma.linkCheck.upsert({
        where: { companyId_targetUrl: { companyId, targetUrl: url } },
        create: { companyId, targetUrl: url, status: r.status, ok: r.ok, kind: t.kind, error: r.error ?? null, sources: t.sources as any, checkedAt: new Date() },
        update: { status: r.status, ok: r.ok, error: r.error ?? null, sources: t.sources as any, checkedAt: new Date() },
      });
    }));
    if (i + BATCH < queue.length) await new Promise((res) => setTimeout(res, 300));
  }

  // drop stale checks for targets no longer linked anywhere
  const live = new Set(queue.map(([u]) => u));
  await prisma.linkCheck.deleteMany({ where: { companyId, targetUrl: { notIn: [...live] }, checkedAt: { lt: new Date(Date.now() - 7 * 864e5) } } });

  console.log(`[link-audit] ${companyId}: ${checked} links checked, ${broken} broken`);
  return { checked, broken };
}
