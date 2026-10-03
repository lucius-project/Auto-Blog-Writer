import type { Job } from "bullmq";
import { BenchmarkQueriesPayload, QUEUES } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";
import { getQueue } from "../lib/queues.js";
import { countryName } from "../lib/taxonomy.js";

type Q = { query: string; intent: string };

const RULES = `Rules:
- Write what people actually TYPE into Google or ask an AI assistant: short (2-9 words), natural, no quotes, no punctuation beyond what a searcher would use.
- Include the city or region where a local searcher naturally would (most service searches), but not in every query.
- NEVER include any company's brand name (not the tenant's, not competitors').
- Each query must be distinct in intent, not a rephrasing of another.
- Only commercially meaningful searches from someone who could become a client — no careers, salaries, consumer tech, or trivia.
Return {"queries":[{"query":"...","intent":"local|vertical|problem|comparison|compliance"}]}`;

/**
 * Build the competitive benchmark query set: the searches the BrandScript's
 * hero (per industry, per city) would run when looking for the help this
 * company sells. The set stays fixed between runs so scores are comparable
 * over time; manual queries are never touched.
 */
export async function benchmarkQueries(job: Job) {
  const payload = BenchmarkQueriesPayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: payload.companyId },
    include: { locations: { include: { verticals: true } } },
  });
  const profile = (company.profile ?? {}) as any;
  const bs = profile.brandScript ?? {};

  if (payload.replace) {
    await prisma.benchmarkQuery.deleteMany({ where: { companyId: company.id, source: "auto" } });
  }
  const existing = await prisma.benchmarkQuery.findMany({ where: { companyId: company.id }, select: { locationId: true, verticalId: true, query: true } });
  const seen = new Set(existing.map((e) => `${e.locationId}|${e.verticalId ?? ""}|${e.query.toLowerCase()}`));
  let created = 0;
  const save = async (locationId: string, verticalId: string | null, qs: Q[]) => {
    for (const q of qs) {
      const query = (q.query ?? "").trim().replace(/\s+/g, " ");
      const key = `${locationId}|${verticalId ?? ""}|${query.toLowerCase()}`;
      if (query.length < 4 || seen.has(key)) continue;
      seen.add(key);
      await prisma.benchmarkQuery.create({
        data: { companyId: company.id, locationId, verticalId, query, intent: q.intent || "vertical", source: "auto" },
      });
      created++;
    }
  };

  for (const loc of company.locations) {
    const where = `${loc.city}${loc.state ? `, ${loc.state}` : ""}, ${countryName(loc.country)}`;
    await job.updateProgress({ step: `queries: ${loc.city}` }).catch(() => {});

    // general local searches: anyone in this city needing the company's help
    if (payload.perLocation > 0) {
      const res = await chatJson<{ queries: Q[] }>([
        { role: "system", content: "You are a local SEO strategist. You predict the exact searches business owners run when they need the help a company provides. Reply JSON only." },
        { role: "user", content: `Generate ${payload.perLocation} general local searches (intent "local", plus a few "problem" or "comparison") a business owner in ${where} would run when they need this company's kind of help — not specific to one industry.
COMPANY SERVICES: ${JSON.stringify(profile.services ?? []).slice(0, 800)}
HERO & PROBLEM (StoryBrand): ${JSON.stringify({ character: bs.character, problem: bs.problem }).slice(0, 1200)}
${RULES}` },
      ], { companyId: company.id, tag: "benchmark-queries", maxTokens: 1500, temperature: 0.4 });
      await save(loc.id, null, res.queries ?? []);
    }

    // industry searches, driven by that vertical's own BrandScript
    for (const v of loc.verticals) {
      const vp = (v.profile ?? {}) as any;
      const vbs = vp.brandScript ?? {};
      const res = await chatJson<{ queries: Q[] }>([
        { role: "system", content: "You are a local SEO strategist and StoryBrand practitioner. You predict the exact searches a specific kind of business runs when its technology problems push it to look for help. Reply JSON only." },
        { role: "user", content: `Generate ${payload.perPair} searches a ${v.name} business in ${where} would run on the way to hiring an IT/cybersecurity provider.
Mix: ~40% "vertical" (IT help for their industry, e.g. "IT support for law firms <city>"), ~30% "problem" (their external problem in their own vocabulary and software names), ~20% "comparison" (choosing/evaluating a provider), ~10% "compliance" (only frameworks that apply in ${countryName(loc.country)}).
THEIR BRANDSCRIPT: ${JSON.stringify({ character: vbs.character, problem: vbs.problem, failure: vbs.failure, vocabulary: vbs.vocabulary, storyHooks: vbs.storyHooks }).slice(0, 2500)}
THEIR TOOLS: ${JSON.stringify(vp.toolsAndVendorsUsed ?? []).slice(0, 500)}
THEIR COMPLIANCE: ${JSON.stringify(vp.complianceFrameworks ?? []).slice(0, 400)}
BUYER QUESTIONS: ${JSON.stringify(vp.buyerQuestions ?? []).slice(0, 1200)}
${RULES}` },
      ], { companyId: company.id, tag: "benchmark-queries", maxTokens: 2500, temperature: 0.4 });
      await save(loc.id, v.id, res.queries ?? []);
    }
  }

  const total = await prisma.benchmarkQuery.count({ where: { companyId: company.id, active: true } });
  if (payload.runAfter) {
    await getQueue(QUEUES.runBenchmark).add(QUEUES.runBenchmark, { companyId: company.id });
  }
  console.log(`[benchmark-queries] ${company.name}: ${created} new, ${total} active`);
  return { status: "ok", created, total };
}
