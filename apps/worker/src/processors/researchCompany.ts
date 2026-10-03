import type { Job } from "bullmq";
import { ResearchCompanyPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { notify } from "../lib/notify.js";
import { getQueue } from "../lib/queues.js";
import { QUEUES } from "@abw/shared";
import { chatJson } from "../lib/openrouter.js";
import { fetchText, extractPage } from "../lib/site.js";
import { countryName } from "../lib/taxonomy.js";

const BRANDSCRIPT_SYSTEM = `You are a StoryBrand (Donald Miller, "Building a StoryBrand" SB7 framework) strategist writing a BrandScript for a B2B service company.
Core rule: the CUSTOMER is the hero, the company is the GUIDE. The BrandScript is about who they serve, the customer's problems and what the customer wants — not about what the company sells or knows. Avoid the "sea of sameness": never use claims every competitor makes (fast response, trusted partner, full-service, cutting-edge, tailored solutions, peace of mind) as a differentiator.
Problems, stakes and success may use general, conservative industry knowledge. AUTHORITY and AGREEMENT items must come ONLY from the provided company facts (testimonials, years, certifications, guarantees, stats actually stated) — empty array if none. Never invent numbers. Reply with JSON only.`;

const BRANDSCRIPT_SHAPE = `{"character":{"who":"exactly who the hero is (role + business type + size)","wants":"the ONE thing they want, tied to survival: grow revenue, save time/money, reduce risk, keep their reputation"},"problem":{"villain":"the root cause personified as a single antagonist (e.g. 'technology that only gets attention after it breaks')","external":"the tangible problem they'd describe","internal":"how that problem makes them FEEL (frustrated, anxious, embarrassed, stuck)","philosophical":"why it's just plain wrong — 'you shouldn't have to…'"},"guide":{"empathy":["2-4 statements proving we understand how they feel, in their language"],"authority":["proof points ONLY from the provided facts"]},"plan":{"process":["exactly 3 simple steps a customer takes to work with the company"],"agreement":["promises that remove fear of doing business — ONLY if stated in the facts"]},"callToAction":{"direct":"the one clear next step (e.g. 'Schedule a free IT assessment')","transitional":"a low-commitment next step (checklist, guide, assessment) or null"},"failure":["3-5 concrete consequences of doing nothing"],"success":["3-5 concrete pictures of their business after the problem is solved"],"transformation":{"from":"who they are before","to":"who they become"},"oneLiner":"problem → plan → success in 1-2 sentences","samenessToAvoid":["generic claims competitors in this space all make — writers must never lead with these"]}`;

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
  const missingVerticalProfiles = company.locations.some((l) => l.verticals.some((v) => !(v.profile as any)?.brandScript));
  if ((company.profile as any)?.brandScript && !payload.force && !missingVerticalProfiles) {
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

  // StoryBrand BrandScript (company level) — backfilled onto existing
  // profiles without re-running the profile research
  if (!(profile as any).brandScript || payload.force) {
    const brandScript = await chatJson<Record<string, unknown>>([
      { role: "system", content: BRANDSCRIPT_SYSTEM },
      { role: "user", content: `Build the company-level BrandScript as JSON:
${BRANDSCRIPT_SHAPE}

COMPANY: ${company.name} (${company.url})
COMPANY PROFILE: ${JSON.stringify({ ...profile, brandScript: undefined }).slice(0, 3000)}

SITE PAGES:
${grounding.join("\n\n---\n\n").slice(0, 12000)}` },
    ], { companyId: company.id, tag: "research-brandscript", maxTokens: 2500, temperature: 0.4 });
    (profile as any).brandScript = brandScript;
    await prisma.company.update({
      where: { id: company.id },
      data: { profile: { ...profile, researchedAt: (profile as any).researchedAt ?? new Date().toISOString() } as any },
    });
  }

  // Vertical profiles: industry pain points + how THIS company serves them
  let verticalsDone = 0;
  for (const loc of company.locations) {
    for (const v of loc.verticals) {
      const existing = (v.profile ?? null) as Record<string, unknown> | null;
      if (existing?.brandScript && !payload.force) continue;
      const industryPages = await prisma.sitePage.findMany({
        where: { companyId: company.id, contentType: "industry" },
        take: 6,
      });
      const relevant = industryPages.filter((p) =>
        (p.title ?? "").toLowerCase().includes(v.name.split(" ")[0]?.toLowerCase() ?? "") ||
        (p.primaryTopic ?? "").toLowerCase().includes(v.name.split(" ")[0]?.toLowerCase() ?? ""));
      const vProfile = (existing && !payload.force) ? existing : await chatJson<Record<string, unknown>>([
        { role: "system", content: "You are an industry analyst. Build a vertical profile for AI-search content. General industry knowledge is allowed and should be marked as such; company-specific claims must come only from the provided pages. Reply with JSON only." },
        { role: "user", content: `JSON: {"industryPainPoints":["..."],"toolsAndVendorsUsed":["software/tools this vertical actually uses"],"complianceFrameworks":["only frameworks that actually apply in ${countryName(loc.country)} — do not use frameworks from other countries"],"buyerQuestions":["the 10-15 most important questions this vertical asks about IT, phrased as they'd ask an AI"],"terminology":["..."],"howCompanyServesThisVertical":"only from provided pages; null if nothing on site","localAngle":"how ${loc.city}, ${loc.state ?? ""}, ${countryName(loc.country)} specifics affect this vertical (regulations, market) — use ${countryName(loc.country)} regulatory bodies and laws, never another country's"}

VERTICAL: ${v.name} | LOCATION: ${loc.city}, ${loc.state ?? ""}, ${countryName(loc.country)} | COMPANY: ${company.name}
COMPANY PROFILE: ${JSON.stringify(profile).slice(0, 1500)}
COMPANY INDUSTRY PAGES: ${relevant.map((p) => `${p.title}: ${JSON.stringify(p.questionsAnswered)}`).join("\n") || "none found on site"}` },
      ], { companyId: company.id, tag: "research-vertical", maxTokens: 2000, temperature: 0.3 });
      // Vertical BrandScript: each industry is its own hero with its own
      // problems, stakes and picture of success
      const vBrandScript = await chatJson<Record<string, unknown>>([
        { role: "system", content: BRANDSCRIPT_SYSTEM },
        { role: "user", content: `Build the BrandScript for ONE industry the company serves. The hero is a business in THIS vertical in THIS location, not a generic customer — use their day-to-day reality, their software, their regulators, their vocabulary. Return JSON:
${BRANDSCRIPT_SHAPE.replace(/\}$/, `,"dayInTheLife":"a concrete 2-3 sentence scene of this business when IT goes wrong (generic industry reality, no invented stats)","storyHooks":["4-6 opening scenarios an article could start with, each describing the reader's situation in their own words"],"vocabulary":["words and phrases this industry uses for its own work and problems"]}`)}

VERTICAL: ${v.name} | LOCATION: ${loc.city}, ${loc.state ?? ""}, ${countryName(loc.country)} (use ${countryName(loc.country)} regulations only)
VERTICAL PROFILE: ${JSON.stringify(vProfile).slice(0, 2500)}
COMPANY: ${company.name}
COMPANY BRANDSCRIPT: ${JSON.stringify((profile as any).brandScript ?? {}).slice(0, 2500)}
COMPANY PROFILE: ${JSON.stringify({ ...profile, brandScript: undefined }).slice(0, 1500)}` },
      ], { companyId: company.id, tag: "research-vertical-brandscript", maxTokens: 2500, temperature: 0.4 });
      await prisma.vertical.update({
        where: { id: v.id },
        data: { profile: { ...vProfile, brandScript: vBrandScript, researchedAt: (existing && !payload.force ? existing.researchedAt : undefined) ?? new Date().toISOString() } as any },
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
