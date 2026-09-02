import { XMLParser } from "fast-xml-parser";

const UA = "Mozilla/5.0 (compatible; ABW-Ingest/1.0; +https://github.com/911it/Auto-Blog-Writer)";

export async function fetchText(url: string, timeoutMs = 20000): Promise<{ status: number; text: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, text: await res.text(), finalUrl: res.url };
}

export const AI_CRAWLERS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot",
  "Claude-SearchBot", "Google-Extended", "CCBot", "Bytespider", "meta-externalagent",
];

/** Parse robots.txt and report which AI crawlers are blocked from "/" scope. */
export function auditRobots(robotsTxt: string): { blocked: string[]; sitemaps: string[] } {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; disallows: string[] }[] = [];
  let current: { agents: string[]; disallows: string[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const val = (m[2] ?? "").trim();
    if (key === "sitemap" && val) sitemaps.push(val);
    else if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      if (key === "disallow" && current) current.disallows.push(val);
      lastWasAgent = false;
    }
  }
  const blocked = AI_CRAWLERS.filter((bot) => {
    const b = bot.toLowerCase();
    // a bot is blocked if a group naming it (or *) disallows "/" — specific
    // group wins over *
    const specific = groups.filter((g) => g.agents.some((a) => a === b));
    const star = groups.filter((g) => g.agents.includes("*"));
    const applicable = specific.length ? specific : star;
    return applicable.some((g) => g.disallows.some((d) => d === "/"));
  });
  return { blocked, sitemaps };
}

const COMMON_SITEMAP_PATHS = [
  "/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml",
  "/wp-sitemap.xml", "/post-sitemap.xml",
];

/** Discover sitemap URLs: robots.txt directives, then common paths. */
export async function discoverSitemaps(baseUrl: string, robotsSitemaps: string[]): Promise<string[]> {
  if (robotsSitemaps.length) return robotsSitemaps;
  const origin = new URL(baseUrl).origin;
  for (const p of COMMON_SITEMAP_PATHS) {
    try {
      const { status, text } = await fetchText(origin + p, 10000);
      if (status === 200 && text.includes("<urlset") ) return [origin + p];
      if (status === 200 && text.includes("<sitemapindex")) return [origin + p];
    } catch { /* try next */ }
  }
  return [];
}

/** Expand sitemap (and one level of sitemap index) into page URLs. */
export async function sitemapUrls(sitemapUrl: string): Promise<string[]> {
  const parser = new XMLParser();
  const { text } = await fetchText(sitemapUrl);
  const doc = parser.parse(text);
  const urls: string[] = [];
  const toArr = (x: unknown): any[] => (Array.isArray(x) ? x : x ? [x] : []);
  if (doc.sitemapindex) {
    for (const sm of toArr(doc.sitemapindex.sitemap)) {
      if (!sm?.loc) continue;
      try {
        const { text: childText } = await fetchText(String(sm.loc));
        const child = parser.parse(childText);
        for (const u of toArr(child.urlset?.url)) if (u?.loc) urls.push(String(u.loc));
      } catch { /* skip child */ }
    }
  }
  for (const u of toArr(doc.urlset?.url)) if (u?.loc) urls.push(String(u.loc));
  return [...new Set(urls)];
}

export interface PageExtract {
  title: string;
  h1: string;
  headings: string[];
  hasJsonLd: boolean;
  wordCount: number;
  textSample: string;
  metaDescription: string;
}

/** Cheap regex-based extraction — enough for classification + structure score. */
export function extractPage(html: string): PageExtract {
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const h1 = strip(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const headings = [...html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((m) => strip(m[1] ?? "")).filter(Boolean).slice(0, 30);
  const metaDescription = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ?? "";
  const hasJsonLd = /application\/ld\+json/i.test(html);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const text = strip(body);
  return {
    title, h1, headings, hasJsonLd, metaDescription,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    textSample: text.slice(0, 1500),
  };
}

export interface PageLink { href: string; path: string; anchor: string; kind: "internal" | "external" }

const norm = (h: string) => h.replace(/^www\./, "").toLowerCase();

/**
 * Pull the <a href> graph from a page. Relative hrefs resolve against pageUrl;
 * fragments, mailto/tel/js are dropped; kind is internal when the host matches
 * the page's host (www-insensitive). Deduped by resolved URL (first anchor wins).
 */
export function extractLinks(html: string, pageUrl: string): PageLink[] {
  const host = norm(new URL(pageUrl).hostname);
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // ignore nav/footer? keep everything — the graph is the point
  const out = new Map<string, PageLink>();
  for (const m of html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = (m[1] ?? "").trim();
    if (!raw || /^(mailto:|tel:|javascript:|#|data:)/i.test(raw)) continue;
    let u: URL;
    try { u = new URL(raw, pageUrl); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    const key = u.toString().replace(/\/$/, "");
    if (out.has(key)) continue;
    out.set(key, {
      href: u.toString(),
      path: u.pathname + (u.search || ""),
      anchor: strip(m[2] ?? "").slice(0, 120),
      kind: norm(u.hostname) === host ? "internal" : "external",
    });
  }
  return [...out.values()];
}

/** 0-100 structural extractability score (answer-block/table/FAQ heuristics). */
export function structureScore(html: string, ex: PageExtract): number {
  let s = 0;
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (h1Count === 1) s += 20;
  if (ex.headings.length >= 3) s += 15;
  if (/<h2[^>]*>[^<]*\?/i.test(html)) s += 10; // question-shaped H2
  if (/<table[\s>]/i.test(html)) s += 10;
  if (/<[uo]l[\s>]/i.test(html)) s += 10;
  if (ex.hasJsonLd) s += 15;
  if (/faq|frequently asked/i.test(html)) s += 10;
  if (ex.wordCount > 600) s += 10;
  return Math.min(100, s);
}
