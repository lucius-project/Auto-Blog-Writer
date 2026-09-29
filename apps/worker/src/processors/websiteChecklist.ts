import type { Job } from "bullmq";
import { WebsiteChecklistPayload, type ChecklistItem } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { fetchText, auditRobots, discoverSitemaps, sitemapUrls, extractPage, extractLinks } from "../lib/site.js";

/**
 * Website SEO/AEO checklist — live checks of the tenant's OWN site, aimed at
 * what AI answers and local search actually weigh: a page per location with
 * LocalBusiness data, a deep page per industry, industry x city tied together
 * on one page, visible reviews, plus technical basics. Off-site work the app
 * can't verify (Business Profile, reviews, directories) becomes manual items.
 * Pages are found via the live sitemap plus the last crawl (SitePage), and
 * re-fetched live here.
 */

type Fetched = {
  url: string;
  ok: boolean;
  text: string; // visible text
  lc: string; // lowercase visible text
  html: string;
  ldTypes: Set<string>;
  ldHasAddress: boolean;
  internalPaths: Set<string>;
  title: string;
  metaDescription: string;
  h1Count: number;
  wordCount: number;
};

const LOCAL_TYPES = /LocalBusiness|ProfessionalService|Store|HomeAndConstructionBusiness|AccountingService|ITService/;
const BLOG_PATH = /\/20\d\d\/\d\d\//;
const STOP = new Set(["firms", "firm", "businesses", "business", "companies", "company", "services", "service", "managed", "it", "for", "and", "the", "&"]);
// extra words that mean the same industry on a page or in a path
const SYNONYMS: Record<string, string[]> = {
  construction: ["construction", "contractor", "trades"],
  cpa: ["cpa", "accounting", "accountant", "bookkeep"],
  accounting: ["accounting", "accountant", "cpa", "bookkeep"],
  engineering: ["engineering", "engineer"],
  manufacturing: ["manufacturing", "manufacturer"],
  dental: ["dental", "dentist"],
  legal: ["legal", "law firm", "lawyer"],
};

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const industryWords = (vertical: string): string[] => {
  const base = vertical.toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w && !STOP.has(w));
  return [...new Set(base.flatMap((w) => SYNONYMS[w] ?? [w]))];
};

function ldInfo(html: string): { types: Set<string>; hasAddress: boolean } {
  const types = new Set<string>();
  let hasAddress = false;
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const t = n["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string") types.add(x);
    if (n.address && (typeof n.address === "string" || n.address.streetAddress || n.address.addressLocality)) hasAddress = true;
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1] ?? "")); } catch { /* malformed block */ }
  }
  return { types, hasAddress };
}

async function fetchPage(url: string): Promise<Fetched> {
  try {
    const res = await fetchText(url, 20000);
    const html = res.text;
    const ex = extractPage(html);
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
    const text = body.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const ld = ldInfo(html);
    return {
      url: res.finalUrl || url, ok: res.status === 200, html, text, lc: text.toLowerCase(),
      ldTypes: ld.types, ldHasAddress: ld.hasAddress,
      internalPaths: new Set(extractLinks(html, res.finalUrl || url).filter((l) => l.kind === "internal").map((l) => l.path.replace(/\/$/, "") || "/")),
      title: ex.title, metaDescription: ex.metaDescription,
      h1Count: (html.match(/<h1[\s>]/gi) ?? []).length, wordCount: ex.wordCount,
    };
  } catch {
    return { url, ok: false, html: "", text: "", lc: "", ldTypes: new Set(), ldHasAddress: false, internalPaths: new Set(), title: "", metaDescription: "", h1Count: 0, wordCount: 0 };
  }
}

const hasLocalLd = (p: Fetched) => [...p.ldTypes].some((t) => LOCAL_TYPES.test(t));
const pathOf = (u: string) => { try { return new URL(u).pathname.replace(/\/$/, "") || "/"; } catch { return u; } };
const showsReviews = (p: Fetched) => /\breviews?\b|testimonial|what (our )?clients say|★|google rating|5\.0 stars?/i.test(p.text);
const PHONE = /\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/;

export async function websiteChecklist(job: Job) {
  const { companyId } = WebsiteChecklistPayload.parse(job.data);
  await prisma.websiteChecklist.upsert({
    where: { companyId }, create: { companyId, status: "running" }, update: { status: "running", error: null },
  });
  try {
    const items = await runChecks(companyId);
    await prisma.websiteChecklist.update({
      where: { companyId },
      data: { status: "idle", error: null, items: items as any, liveFetchedAt: new Date() },
    });
    const failing = items.filter((i) => i.status === "fail").length;
    console.log(`[website-checklist] ${companyId}: ${items.length} items, ${failing} failing`);
    return { status: "ok", items: items.length, failing };
  } catch (e: any) {
    await prisma.websiteChecklist.update({ where: { companyId }, data: { status: "failed", error: String(e?.message ?? e).slice(0, 500) } });
    throw e;
  }
}

async function runChecks(companyId: string): Promise<ChecklistItem[]> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { locations: { include: { verticals: true } }, analyticsConnection: true },
  });
  const origin = new URL(company.url).origin;
  const items: ChecklistItem[] = [];
  const add = (it: ChecklistItem) => items.push(it);

  type Candidate = { url: string; path: string; title: string | null; contentType: string | null };
  const pages: Candidate[] = (await prisma.sitePage.findMany({ where: { companyId } }))
    .filter((p) => !BLOG_PATH.test(p.path) && p.contentType !== "blog")
    .map((p) => ({ url: p.url, path: p.path, title: p.title, contentType: p.contentType }));
  const cache = new Map<string, Fetched>();
  const live = async (url: string) => {
    if (!cache.has(url)) cache.set(url, await fetchPage(url));
    return cache.get(url)!;
  };

  // ---------------------------------------------------------------- Technical
  const home = await live(origin + "/");
  const insecure = await fetchText(`http://${new URL(company.url).hostname}/`, 15000).catch(() => null);
  add({
    key: "tech:https", category: "Technical", impact: "high", title: "Site forces HTTPS",
    status: insecure && insecure.finalUrl.startsWith("https://") ? "pass" : "fail",
    detail: insecure ? `http:// ends at ${insecure.finalUrl}` : "Couldn't reach the http:// version of the site.",
    fix: "Redirect every http:// URL to https:// (your host or an SSL plugin can do this).",
  });

  let robotsTxt = "";
  try { const r = await fetchText(origin + "/robots.txt"); if (r.status === 200) robotsTxt = r.text; } catch { /* none */ }
  const robots = auditRobots(robotsTxt);
  add({
    key: "tech:ai-crawlers", category: "Technical", impact: "high", title: "AI search crawlers are allowed",
    status: robots.blocked.length ? "fail" : "pass",
    detail: robots.blocked.length ? `robots.txt blocks: ${robots.blocked.join(", ")}` : robotsTxt ? "robots.txt allows the AI crawlers." : "No robots.txt — nothing is blocked.",
    fix: "Remove the Disallow rules for these bots in robots.txt so ChatGPT, Perplexity, Claude and Google AI can read and cite the site.",
    url: origin + "/robots.txt",
  });

  const sitemaps = await discoverSitemaps(company.url, robots.sitemaps).catch(() => [] as string[]);
  // pages created since the last crawl still count: add the live sitemap's non-blog URLs
  if (sitemaps[0]) {
    const known = new Set(pages.map((p) => p.path.replace(/\/$/, "")));
    for (const u of await sitemapUrls(sitemaps[0]).catch(() => [] as string[])) {
      const path = pathOf(u);
      if (BLOG_PATH.test(path) || known.has(path)) continue;
      known.add(path);
      pages.push({ url: u, path, title: null, contentType: null });
    }
  }
  add({
    key: "tech:sitemap", category: "Technical", impact: "medium", title: "XML sitemap is published",
    status: sitemaps.length ? "pass" : "fail",
    detail: sitemaps.length ? `Found ${sitemaps[0]}` : "No sitemap at the usual locations or in robots.txt.",
    fix: "Enable the XML sitemap in your SEO plugin and add a `Sitemap:` line to robots.txt.",
    url: sitemaps[0],
  });

  const titleOk = home.title.length >= 30 && home.title.length <= 60;
  const descOk = home.metaDescription.length >= 70 && home.metaDescription.length <= 160;
  const homeProblems = [
    !titleOk && `title is ${home.title.length} chars (aim 30-60)`,
    !descOk && `meta description is ${home.metaDescription.length} chars (aim 70-155)`,
    home.h1Count !== 1 && `${home.h1Count} H1 headings (should be exactly 1)`,
  ].filter(Boolean) as string[];
  add({
    key: "tech:home-basics", category: "Technical", impact: "medium", title: "Homepage title, description and H1",
    status: !home.ok ? "fail" : homeProblems.length ? "warn" : "pass",
    detail: !home.ok ? "Homepage didn't load." : homeProblems.length ? homeProblems.join("; ") : `“${home.title}”`,
    fix: "In your SEO plugin, give the homepage a 30-60 character title naming what you do and where, a 70-155 character description, and make sure the page has exactly one H1.",
    url: home.url,
  });

  const homeLd = [...home.ldTypes];
  add({
    key: "tech:home-schema", category: "Technical", impact: "high", title: "Homepage identifies the business (Organization / LocalBusiness data)",
    status: hasLocalLd(home) ? "pass" : homeLd.includes("Organization") ? "warn" : "fail",
    detail: homeLd.length ? `Structured data types: ${homeLd.slice(0, 8).join(", ")}` : "No structured data found.",
    fix: "Add LocalBusiness (or ProfessionalService) structured data with your legal name, address, phone, logo, service area and sameAs links to your Google, LinkedIn and directory profiles. Most SEO plugins have a Local Business setting.",
    url: home.url,
  });

  add({
    key: "tech:og-image", category: "Technical", impact: "low", title: "Social share image on the homepage",
    status: /<meta[^>]+property=["']og:image["']/i.test(home.html) ? "pass" : "warn",
    detail: /<meta[^>]+property=["']og:image["']/i.test(home.html) ? "og:image is set." : "No og:image — shared links show no picture.",
    fix: "Set a default social image in your SEO plugin.",
    url: home.url,
  });

  const llms = await fetchText(origin + "/llms.txt", 10000).catch(() => null);
  add({
    key: "tech:llms-txt", category: "Technical", impact: "low", title: "llms.txt summary for AI assistants",
    status: llms && llms.status === 200 && llms.text.length > 50 && !/<html/i.test(llms.text) ? "pass" : "warn",
    detail: llms?.status === 200 ? "llms.txt found." : "No /llms.txt (optional, emerging standard).",
    fix: "Publish /llms.txt: a short plain-text summary of who you are, where you operate, industries served, and links to your key pages.",
  });

  const brokenRows = await prisma.linkCheck.findMany({
    where: { companyId, kind: "internal", ok: false, checkedAt: { gte: new Date(Date.now() - 30 * 86400e3) } },
    distinct: ["targetUrl"], select: { targetUrl: true },
  });
  add({
    key: "tech:broken-links", category: "Technical", impact: "medium", title: "No broken internal links",
    status: brokenRows.length ? "fail" : "pass",
    detail: brokenRows.length ? `${brokenRows.length} broken internal link target(s) in the last link audit, e.g. ${brokenRows[0]!.targetUrl}` : "Last link audit found no broken internal links.",
    fix: "Open SEO → Site map to see each broken link and the page it's on, then fix or remove the link.",
  });

  add({
    key: "tech:search-console", category: "Technical", impact: "medium", title: "Google Search Console connected",
    status: company.analyticsConnection?.gscSiteUrl ? "pass" : "fail",
    detail: company.analyticsConnection?.gscSiteUrl ? `Connected: ${company.analyticsConnection.gscSiteUrl}` : "Not connected — rankings and indexing problems are invisible.",
    fix: "Connect Search Console in Settings → Analytics.",
  });

  // ------------------------------------------------------------ Location pages
  const verticalNames = [...new Set(company.locations.flatMap((l) => l.verticals.map((v) => v.name)))];
  const findPage = (words: string[], prefer: string[]) => {
    const hits = pages.filter((p) => {
      const hay = `${p.path} ${p.title ?? ""}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });
    hits.sort((a, b) => {
      const pa = prefer.includes(a.contentType ?? "") ? 0 : 1, pb = prefer.includes(b.contentType ?? "") ? 0 : 1;
      const inPathA = words.some((w) => a.path.toLowerCase().includes(slug(w))) ? 0 : 1;
      const inPathB = words.some((w) => b.path.toLowerCase().includes(slug(w))) ? 0 : 1;
      return inPathA - inPathB || pa - pb || a.path.length - b.path.length;
    });
    return hits[0] ?? null;
  };

  const industryPages = new Map<string, string>(); // vertical name -> url
  for (const v of verticalNames) {
    const p = findPage(industryWords(v), ["industry", "service", "landing"]);
    if (p) industryPages.set(v, p.url);
  }
  const locationPages = new Map<string, string>(); // city -> url

  for (const loc of company.locations) {
    const city = loc.city;
    const k = slug(city);
    const pg = findPage([city.toLowerCase()], ["location", "landing", "service"]);
    if (!pg) {
      add({
        key: `local:${k}:page`, category: "Location pages", impact: "high", title: `${city} has its own page`,
        status: "fail", detail: `No page about ${city} found in your sitemap or the last site crawl.`,
        fix: `Create a page like /it-support-${k}/ with your ${city} address, phone, the industries you serve there, local client stories and a map. AI answers for "${city}" questions look for exactly this page.`,
      });
      continue;
    }
    locationPages.set(city, pg.url);
    const p = await live(pg.url);
    add({
      key: `local:${k}:page`, category: "Location pages", impact: "high", title: `${city} has its own page`,
      status: p.ok ? "pass" : "fail", detail: p.ok ? `${pathOf(p.url)} · ${p.wordCount} words` : `${pg.url} didn't load.`,
      fix: `Keep ${pathOf(pg.url)} live and linked from the main menu or footer.`, url: pg.url,
    });
    if (!p.ok) continue;

    add({
      key: `local:${k}:schema`, category: "Location pages", impact: "high", title: `${city} page has LocalBusiness data with the address`,
      status: hasLocalLd(p) && p.ldHasAddress ? "pass" : p.ldHasAddress ? "warn" : "fail",
      detail: p.ldTypes.size ? `Structured data types: ${[...p.ldTypes].slice(0, 8).join(", ")}${p.ldHasAddress ? "" : " — no address"}` : "No structured data.",
      fix: `Add LocalBusiness structured data to this page with the ${city} street address, phone, opening hours, geo coordinates and areaServed. Search engines and AI assistants use it to confirm you're local.`,
      url: p.url,
    });

    const phone = PHONE.test(p.text);
    const mentionsCity = p.lc.includes(city.toLowerCase());
    add({
      key: `local:${k}:nap`, category: "Location pages", impact: "medium", title: `${city} page shows address and phone`,
      status: phone && mentionsCity ? "pass" : "fail",
      detail: [phone ? "phone found" : "no phone number", mentionsCity ? `mentions ${city}` : `doesn't mention ${city}`].join(" · "),
      fix: "Show the full address and a click-to-call phone number in the page body, written exactly as on your Google Business Profile.",
      url: p.url,
    });

    const served = [...new Set(loc.verticals.map((v) => v.name))];
    const missing = served.filter((v) => !industryWords(v).some((w) => p.lc.includes(w)));
    if (served.length) {
      add({
        key: `local:${k}:industries`, category: "Location pages", impact: "high", title: `${city} page names the industries you serve there`,
        status: missing.length === 0 ? "pass" : missing.length < served.length ? "warn" : "fail",
        detail: missing.length ? `Not mentioned: ${missing.join(", ")}` : `Mentions all: ${served.join(", ")}`,
        fix: `Add a "Who we help in ${city}" section with a short paragraph per industry (${served.join(", ")}) linking to each industry page. This ties "${city}" and the industry together on one page, which is what AI answers for questions like "best IT for ${served[0]?.toLowerCase()} in ${city}" look for.`,
        url: p.url,
      });
    }

    const linkedIndustry = [...industryPages.entries()].filter(([, u]) => p.internalPaths.has(pathOf(u)));
    if (industryPages.size) {
      add({
        key: `local:${k}:links`, category: "Location pages", impact: "medium", title: `${city} page links to your industry pages`,
        status: linkedIndustry.length === industryPages.size ? "pass" : linkedIndustry.length ? "warn" : "fail",
        detail: `Links to ${linkedIndustry.length} of ${industryPages.size} industry pages.`,
        fix: `Link from the ${city} page to: ${[...industryPages.values()].map(pathOf).join(", ")}.`,
        url: p.url,
      });
    }

    add({
      key: `local:${k}:reviews`, category: "Reviews & trust", impact: "medium", title: `${city} page shows client reviews`,
      status: showsReviews(p) ? "pass" : "fail",
      detail: showsReviews(p) ? "Reviews or testimonials are visible." : "No reviews or testimonials on the page.",
      fix: `Show 2-3 reviews from ${city} clients (with name, business type and star rating) and a link to your Google reviews.`,
      url: p.url,
    });
  }

  // ------------------------------------------------------------ Industry pages
  const testimonials = await prisma.testimonial.findMany({ where: { companyId } });
  for (const v of verticalNames) {
    const k = slug(v);
    const words = industryWords(v);
    const url = industryPages.get(v);
    const cities = [...new Set(company.locations.filter((l) => l.verticals.some((x) => x.name === v)).map((l) => l.city))];
    if (!url) {
      add({
        key: `industry:${k}:page`, category: "Industry pages", impact: "high", title: `${v} has a dedicated page`,
        status: "fail", detail: `No page about ${v} found in your sitemap or the last site crawl.`,
        fix: `Create a page for ${v} covering their specific IT problems, the services you provide them, client stories from that industry, the cities you serve (${cities.join(", ")}), and an FAQ.`,
      });
      continue;
    }
    const p = await live(url);
    add({
      key: `industry:${k}:page`, category: "Industry pages", impact: "high", title: `${v} has a dedicated page`,
      status: p.ok ? "pass" : "fail", detail: p.ok ? pathOf(p.url) : `${url} didn't load.`,
      fix: "Keep it live and linked from the menu.", url,
    });
    if (!p.ok) continue;

    add({
      key: `industry:${k}:depth`, category: "Industry pages", impact: "high", title: `${v} page has enough depth`,
      status: p.wordCount >= 1000 ? "pass" : p.wordCount >= 600 ? "warn" : "fail",
      detail: `${p.wordCount} words (aim for 1,000+).`,
      fix: `Expand with: the top IT problems ${v.toLowerCase()} clients face, how you solve each one, a real client story, what's included and typical pricing ranges, and 5-6 FAQs.`,
      url,
    });

    const missingCities = cities.filter((c) => !p.lc.includes(c.toLowerCase()));
    add({
      key: `industry:${k}:cities`, category: "Industry pages", impact: "high", title: `${v} page names the cities you serve`,
      status: missingCities.length === 0 ? "pass" : missingCities.length < cities.length ? "warn" : "fail",
      detail: missingCities.length ? `Not mentioned: ${missingCities.join(", ")}` : `Mentions ${cities.join(", ")}`,
      fix: `Add a "Serving ${v.toLowerCase()} in ${cities.join(", ")}" section naming each city, and link each one to its location page.`,
      url,
    });

    const industryClients = testimonials.filter((t) => t.industry && words.some((w) => t.industry!.includes(w) || w.includes(t.industry!)));
    const firstName = (n: string | null) => (n ?? "").trim().split(/\s+/)[0] ?? "";
    const onPage = industryClients.filter((t) => firstName(t.clientName).length > 2 && new RegExp(`\\b${firstName(t.clientName)}\\b`).test(p.text));
    add({
      key: `industry:${k}:story`, category: "Reviews & trust", impact: "high", title: `${v} page features a real client story`,
      status: onPage.length || (industryClients.length === 0 && showsReviews(p)) ? "pass" : showsReviews(p) ? "warn" : "fail",
      detail: onPage.length
        ? `Features ${onPage.map((t) => t.clientName).join(", ")}.`
        : industryClients.length
          ? `You have ${industryClients.length} ${v} testimonial(s) that aren't on this page: ${industryClients.slice(0, 3).map((t) => t.clientName).join(", ")}.`
          : showsReviews(p) ? "Shows reviews, but none from this industry." : "No client stories or reviews on the page.",
      fix: industryClients.length
        ? `Add a short case study from ${industryClients.slice(0, 2).map((t) => t.clientName).join(" or ")}: the problem, what you did, and the result in numbers.`
        : `Collect a testimonial from a ${v} client and feature it here.`,
      url,
    });

    add({
      key: `industry:${k}:faq`, category: "Industry pages", impact: "medium", title: `${v} page has an FAQ section`,
      status: /faq|frequently asked/i.test(p.text) ? "pass" : "fail",
      detail: /faq|frequently asked/i.test(p.text) ? "FAQ found." : "No FAQ section.",
      fix: `Add 5-6 questions ${v.toLowerCase()} buyers actually ask (cost, response time, jobsite/field support, compliance, switching providers) with 2-3 sentence answers and FAQPage structured data.`,
      url,
    });

    const linkedLoc = cities.filter((c) => locationPages.has(c) && p.internalPaths.has(pathOf(locationPages.get(c)!)));
    const withPages = cities.filter((c) => locationPages.has(c));
    if (withPages.length) {
      add({
        key: `industry:${k}:links`, category: "Industry pages", impact: "medium", title: `${v} page links to your location pages`,
        status: linkedLoc.length === withPages.length ? "pass" : linkedLoc.length ? "warn" : "fail",
        detail: `Links to ${linkedLoc.length} of ${withPages.length} location pages.`,
        fix: `Link to: ${withPages.map((c) => pathOf(locationPages.get(c)!)).join(", ")}.`,
        url,
      });
    }
  }

  // ------------------------------------------------------- Off-site (manual)
  for (const loc of company.locations) {
    const k = slug(loc.city);
    const served = [...new Set(loc.verticals.map((v) => v.name))];
    add({
      key: `offsite:${k}:gbp`, category: "Off-site", impact: "high", status: "manual",
      title: `Google Business Profile complete for ${loc.city}`,
      detail: "Can't be checked automatically — tick when done.",
      fix: `In Google Business Profile for ${loc.city}: primary category "Computer support and services", add every service including IT for ${served.join(", ") || "each industry you serve"}, hours, photos of the team and office, and post an update at least monthly. Make sure the address and phone match the website exactly.`,
    });
  }
  add({
    key: "offsite:google-reviews", category: "Off-site", impact: "high", status: "manual",
    title: "Grow Google reviews past your top local competitor",
    detail: "AI answers quote review counts and review text. Tick when you have a review-request routine running.",
    fix: `Ask happy clients in each industry for a Google review and suggest they mention their industry and city (e.g. "construction company in ${company.locations[0]?.city ?? "your city"}"). Reply to every review. Aim for a steady few per month rather than a burst.`,
  });
  add({
    key: "offsite:directories", category: "Off-site", impact: "medium", status: "manual",
    title: "Business listings match everywhere (name, address, phone)",
    detail: "Tick when every listing matches the website exactly.",
    fix: "Check and fix: Google Business Profile, Bing Places, Apple Business Connect, BBB, Yelp, LinkedIn, Cloudtango, Clutch and any IT directories you're on. Same name, address and phone format everywhere.",
  });
  for (const v of verticalNames) {
    add({
      key: `offsite:assoc:${slug(v)}`, category: "Off-site", impact: "medium", status: "manual",
      title: `Listed with an industry association for ${v}`,
      detail: "Tick when you're listed in the association's member directory.",
      fix: `Join the regional association for ${v.toLowerCase()} (e.g. your provincial/regional construction or professional association) as a supplier/associate member so you appear in its member directory — a trusted mention AI engines pick up.`,
    });
  }
  add({
    key: "offsite:local-mentions", category: "Off-site", impact: "low", status: "manual",
    title: "Local mentions and links (chamber, sponsorships, local news)",
    detail: "Tick when you have at least a few local sites linking to you.",
    fix: `Join the chamber of commerce in each city (${company.locations.map((l) => l.city).join(", ")}), sponsor a local event or team, and offer local news a short expert comment on tech/security stories.`,
  });
  const openOffpage = await prisma.offPageTask.count({ where: { companyId, status: "open" } });
  add({
    key: "offsite:offpage-tasks", category: "Off-site", impact: "medium", title: "Off-page tasks worked through",
    status: openOffpage === 0 ? "pass" : openOffpage <= 3 ? "warn" : "fail",
    detail: openOffpage ? `${openOffpage} open off-page task(s) — sources AI engines cite where you're missing.` : "No open off-page tasks.",
    fix: "Open SEO → Off-page tasks, use 'Draft copy for me' and submit each listing or post.",
  });

  return items;
}
