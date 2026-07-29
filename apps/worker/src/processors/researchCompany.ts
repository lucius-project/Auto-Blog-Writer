import type { Job } from "bullmq";
import { ResearchCompanyPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { notify } from "../lib/notify.js";
import { getQueue } from "../lib/queues.js";
import { QUEUES } from "@abw/shared";
import { chatJson } from "../lib/openrouter.js";
import { fetchText, extractPage } from "../lib/site.js";

/**
 * Stage 2 — Company & vertical research (grounded in the live site).
 * Builds Company.profile, Location.profile and Vertical.profile used to
 * customize every article. Never invents specifics: unknown facts are
 * returned as nulls / flagged placeholders.
 */
export async function researchCompany(job: Job) {
  const payload = ResearchCompanyPayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: payload.companyId },
    include: { locations: { include: { verticals: true } } },
  });
  const missingVerticalProfiles = company.locations.some((l) => l.verticals.some((v) => !v.profile));
  if (company.profile && !payload.force && !missingVerticalProfiles) {
    return { status: "skipped_existing", companyId: company.id };
  }

  // Ground in real pages: home + about/services/industry pages from coverage map
  const pages = await prisma.sitePage.findMany({
    where: { companyId: company.id, contentType: { in: ["home", "service", "industry", "location"] } },
    orderBy: { structureScore: "desc" },
    take: 10,
  });
  const grounding: string[] = [];
  const targets = pages.length
    ? pages.map((p) => p.url)
    : [company.url, new URL("/about-us", company.url).toString()];
  for (const url of targets.slice(0, 8)) {
    try {
      const { status, text } = await fetchText(url);
      if (status !== 200) continue;
      const ex = extractPage(text);
      grounding.push(`URL: ${url}\nTITLE: ${ex.title}\nH1: ${ex.h1}\nHEADINGS: ${ex.headings.join(" | ")}\nTEXT: ${ex.textSample}`);
    } catch { /* skip */ }
  }

  const profile = (company.profile && !payload.force)
    ? (company.profile as Record<string, unknown>)
    : await chatJson<Record<string, unknown>>([
    { role: "system", content: "You are a B2B research analyst building a grounded company profile for AI-search content generation. Use ONLY facts present in the provided pages; set unknown fields to null. Never invent numbers, certifications, or claims. Reply with JSON only." },
    { role: "user", content: `Build a JSON profile of this company:
{"whatTheyDo":"1-2 sentences","services":["..."],"differentiators":["what makes them unique - only claims actually on the site"],"targetCustomers":"...","companySizeHints":null,"pricingHints":null,"certifications":[],"guarantees":[],"brandVoice":"tone observed on the site","locationsMentioned":["..."],"proofPoints":["testimonial themes, stats, years in business - only if stated"],"unknownsToAskOwner":["specific facts that would strengthen content but are not on the site"]}

COMPANY: ${company.name} (${company.url})

SITE PAGES:
${grounding.join("\n\n---\n\n")}` },
  ], { companyId: company.id, tag: "research-company", maxTokens: 2500, temperature: 0.2 });

  if (!company.profile || payload.force) {
    await prisma.company.update({
      where: { id: company.id },
      data: { profile: { ...profile, researchedAt: new Date().toISOString() } },
    });
  }

  // Vertical profiles: industry pain points + how THIS company serves them
  let verticalsDone = 0;
  for (const loc of company.locations) {
    for (const v of loc.verticals) {
      if (v.profile && !payload.force) continue;
      const industryPages = await prisma.sitePage.findMany({
        where: { companyId: company.id, contentType: "industry" },
        take: 6,
      });
      const relevant = industryPages.filter((p) =>
        (p.title ?? "").toLowerCase().includes(v.name.split(" ")[0]?.toLowerCase() ?? "") ||
        (p.primaryTopic ?? "").toLowerCase().includes(v.name.split(" ")[0]?.toLowerCase() ?? ""));
      const vProfile = await chatJson<Record<string, unknown>>([
        { role: "system", content: "You are an industry analyst. Build a vertical profile for AI-search content. General industry knowledge is allowed and should be marked as such; company-specific claims must come only from the provided pages. Reply with JSON only." },
        { role: "user", content: `JSON: {"industryPainPoints":["..."],"toolsAndVendorsUsed":["software/tools this vertical actually uses"],"complianceFrameworks":["..."],"buyerQuestions":["the 10-15 most important questions this vertical asks about IT, phrased as they'd ask an AI"],"terminology":["..."],"howCompanyServesThisVertical":"only from provided pages; null if nothing on site","localAngle":"how ${loc.city}, ${loc.state ?? ""} specifics affect this vertical (regulations, market)"}

VERTICAL: ${v.name} | LOCATION: ${loc.city}, ${loc.state ?? ""} | COMPANY: ${company.name}
COMPANY PROFILE: ${JSON.stringify(profile).slice(0, 1500)}
COMPANY INDUSTRY PAGES: ${relevant.map((p) => `${p.title}: ${JSON.stringify(p.questionsAnswered)}`).join("\n") || "none found on site"}` },
      ], { companyId: company.id, tag: "research-vertical", maxTokens: 2000, temperature: 0.3 });
      await prisma.vertical.update({
        where: { id: v.id },
        data: { profile: { ...vProfile, researchedAt: new Date().toISOString() } },
      });
      verticalsDone++;
    }
  }

  if (payload.chainAnalyze) {
    // now that profiles exist, rebuild the topic graph (seeds industry
    // questions for the new verticals from their researched profiles)
    await getQueue(QUEUES.analyzeGaps).add(QUEUES.analyzeGaps, { companyId: company.id, liveProbeCount: 6 });
  }
  await notify({
    companyId: company.id,
    type: "info",
    title: verticalsDone
      ? `Research done: ${verticalsDone} new vertical profile${verticalsDone === 1 ? "" : "s"} built`
      : "Research done — everything already profiled",
    body: payload.chainAnalyze ? "Topic graph is rebuilding now — new industry questions appear in Topics in a few minutes." : undefined,
    href: `/company/${company.id}/topics`,
  });
  console.log(`[research-company] ${company.name}: profile built, ${verticalsDone} vertical profiles`);
  return { status: "ok", companyId: company.id, verticalsDone };
}
