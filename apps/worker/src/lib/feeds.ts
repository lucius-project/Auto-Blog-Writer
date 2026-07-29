import { prisma } from "./prisma.js";
import { chatJson } from "./openrouter.js";

/**
 * Event/trigger engine (Part II §2.7 of the plan): timely topics are fresh
 * by definition, high-winnability, and inherently un-templated.
 * v1 feeds: CISA KEV (actively-exploited vulns) + endoflife.date (EOL dates).
 * Never newsjacks a specific victim — topics target the threat/trend.
 */

export async function newsTopicsForCompany(companyId: string): Promise<number> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { locations: { include: { verticals: true } } },
  });
  const verticalNames = company.locations.flatMap((l) => l.verticals.map((v) => v.name));

  // CISA KEV: vulnerabilities added in the last 14 days
  let kevRecent: { cveID: string; vendorProject: string; product: string; shortDescription: string }[] = [];
  try {
    const res = await fetch("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", { signal: AbortSignal.timeout(20000) });
    const data = (await res.json()) as any;
    const cutoff = Date.now() - 14 * 24 * 3600e3;
    kevRecent = (data.vulnerabilities ?? [])
      .filter((v: any) => new Date(v.dateAdded).getTime() > cutoff)
      .slice(0, 20);
  } catch (e: any) { console.warn(`[feeds] KEV fetch failed: ${e?.message}`); }

  // endoflife.date: products SMBs actually run
  const eolSoon: { product: string; cycle: string; eol: string }[] = [];
  for (const product of ["windows", "windows-server", "office", "exchange", "sqlserver"]) {
    try {
      const res = await fetch(`https://endoflife.date/api/${product}.json`, { signal: AbortSignal.timeout(15000) });
      const cycles = (await res.json()) as any[];
      for (const c of cycles) {
        if (typeof c.eol !== "string") continue;
        const eolDate = new Date(c.eol).getTime();
        const months6 = Date.now() + 183 * 24 * 3600e3;
        if (eolDate > Date.now() && eolDate < months6) eolSoon.push({ product, cycle: String(c.cycle), eol: c.eol });
      }
    } catch { /* skip product */ }
  }
  if (!kevRecent.length && !eolSoon.length) return 0;

  // Turn raw events into buyer-phrased questions relevant to the tenant
  const res = await chatJson<{ topics: { question: string; category: string; urgency: number }[] }>([
    { role: "system", content: "You turn security/lifecycle events into buyer-phrased questions an SMB would ask an AI. Only include events genuinely relevant to small/mid businesses in the given verticals. Never name breach victims. urgency is 0-1. Reply JSON only." },
    { role: "user", content: `VERTICALS: ${verticalNames.join(", ") || "general SMB"}\n\nRECENT ACTIVELY-EXPLOITED VULNS (CISA KEV):\n${kevRecent.map((k) => `${k.cveID} ${k.vendorProject} ${k.product}: ${k.shortDescription?.slice(0, 120)}`).join("\n") || "none"}\n\nUPCOMING END-OF-LIFE:\n${eolSoon.map((e) => `${e.product} ${e.cycle} EOL ${e.eol}`).join("\n") || "none"}\n\nReturn {"topics":[{"question":"...","category":"security-event|eol","urgency":0.0-1.0}]} — max 8, only the genuinely important ones.` },
  ], { companyId, tag: "news-topics", maxTokens: 2000, temperature: 0.3 });

  let created = 0;
  for (const t of (res.topics ?? []).slice(0, 8)) {
    const first = company.locations[0];
    await prisma.topicNode.upsert({
      where: { companyId_locationId_verticalId_question: {
        companyId, locationId: first?.id ?? null, verticalId: null, question: t.question,
      } as any },
      create: {
        companyId, locationId: first?.id ?? null, verticalId: null,
        question: t.question, category: t.category, funnelStage: "awareness", source: "news",
        score: 50 + t.urgency * 50,
        scoreParts: { urgency: t.urgency, trigger: true },
        evidence: { trigger: t.category, liveFetchedAt: new Date().toISOString() },
      },
      update: { score: 50 + t.urgency * 50 },
    });
    created++;
  }
  console.log(`[feeds] ${company.name}: ${created} news-driven topics (KEV ${kevRecent.length}, EOL ${eolSoon.length})`);
  return created;
}
