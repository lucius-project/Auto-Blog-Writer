import type { Job } from "bullmq";
import { AnalyzeGapsPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";
import { serpProbe } from "../lib/dataforseo.js";
import { TEMPLATES, frameworksFor, fillTemplate } from "../lib/taxonomy.js";

const INTENT_W: Record<string, number> = { awareness: 0.6, consideration: 0.85, decision: 1.0, compliance: 0.95 };

/**
 * Stage 3 — Topic Graph build/refresh + gap scoring.
 *
 * 1. Seed/refresh the graph: taxonomy x (vertical, location) + vertical
 *    buyerQuestions from research.
 * 2. Coverage matching: LLM-diff graph questions against the site coverage
 *    map -> unanswered / answered_weak / answered_strong.
 * 3. LIVE evidence: top-N unanswered/weak nodes get a live SERP + AI
 *    Overview probe (who is cited, is tenant present). liveFetchedAt is
 *    stamped from the actual fetch — never reused across runs.
 * 4. Score nodes; emit OffPageTasks from directory-style domains the
 *    engines cite; write a VisibilitySnapshot.
 */
export async function analyzeGaps(job: Job) {
  const payload = AnalyzeGapsPayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: payload.companyId },
    include: { locations: { include: { verticals: true } } },
  });
  const runStartedAt = new Date();
  const tenantHost = new URL(company.url).hostname;

  // ---- 1. Seed the topic graph ----
  const pairs: { locationId: string | null; verticalId: string | null; vars: Record<string, string>; buyerQs: string[] }[] = [];
  for (const loc of company.locations) {
    if (payload.locationId && loc.id !== payload.locationId) continue;
    for (const v of loc.verticals) {
      if (payload.verticalId && v.id !== payload.verticalId) continue;
      const frameworks = frameworksFor(loc.country, v.slug);
      pairs.push({
        locationId: loc.id, verticalId: v.id,
        vars: { vertical: v.name.toLowerCase(), location: `${loc.city}${loc.state ? ", " + loc.state : ""}`, framework: frameworks[0] ?? "SOC 2" },
        buyerQs: (((v.profile as any)?.buyerQuestions ?? []) as string[]).slice(0, 15),
      });
    }
  }

  let seeded = 0;
  for (const pair of pairs) {
    const questions = new Map<string, { category: string; funnelStage: string; source: string }>();
    for (const t of TEMPLATES) {
      // service templates: instantiate for the 4 core services to bound size
      if (t.q.includes("[service]")) {
        for (const svc of ["managed IT services", "cybersecurity", "co-managed IT", "backup and disaster recovery"]) {
          questions.set(fillTemplate(t.q, { ...pair.vars, service: svc }), { category: t.category, funnelStage: t.funnelStage, source: "taxonomy" });
        }
      } else {
        questions.set(fillTemplate(t.q, pair.vars), { category: t.category, funnelStage: t.funnelStage, source: "taxonomy" });
      }
    }
    for (const q of pair.buyerQs) questions.set(q, { category: "vertical", funnelStage: "consideration", source: "research" });
    for (const [question, metaInfo] of questions) {
      await prisma.topicNode.upsert({
        where: { companyId_locationId_verticalId_question: {
          companyId: company.id, locationId: pair.locationId, verticalId: pair.verticalId, question,
        } as any },
        create: {
          companyId: company.id, locationId: pair.locationId, verticalId: pair.verticalId,
          question, category: metaInfo.category, funnelStage: metaInfo.funnelStage, source: metaInfo.source,
        },
        update: {},
      });
      seeded++;
    }
  }

  // ---- 1b. Graph expansion toward full coverage (1000-2000 questions) ----
  if (payload.expandPerPair > 0) {
    for (const pair of pairs) {
      const existing = await prisma.topicNode.findMany({
        where: { companyId: company.id, locationId: pair.locationId, verticalId: pair.verticalId },
        select: { question: true },
      });
      const res = await chatJson<{ questions: { q: string; category: string; funnelStage: string }[] }>([
        { role: "system", content: "You generate the questions a specific buyer persona would ask an AI assistant. Each must be genuinely distinct (no rephrasings of existing ones), specific, and realistically asked by an SMB buyer. Reply JSON only." },
        { role: "user", content: `Buyer: ${pair.vars.vertical} business decision-maker in ${pair.vars.location}, evaluating or using IT services.\nEXISTING QUESTIONS (do not duplicate or rephrase):\n${existing.map((e) => e.question).join("\n")}\n\nGenerate ${payload.expandPerPair} NEW questions across topics like: pricing, contracts, onboarding, switching, tools (Microsoft 365, EHR, accounting software...), security incidents, backups, compliance details, remote work, vendor comparisons, hiring vs outsourcing.\nReturn {"questions":[{"q":"...","category":"one of: service|pricing|comparison|cybersecurity|compliance|tools|operations|local","funnelStage":"awareness|consideration|decision|compliance"}]}` },
      ], { companyId: company.id, tag: "expand-graph", maxTokens: 12000, temperature: 0.7 });
      for (const q of res.questions ?? []) {
        await prisma.topicNode.upsert({
          where: { companyId_locationId_verticalId_question: {
            companyId: company.id, locationId: pair.locationId, verticalId: pair.verticalId, question: q.q,
          } as any },
          create: {
            companyId: company.id, locationId: pair.locationId, verticalId: pair.verticalId,
            question: q.q, category: q.category, funnelStage: q.funnelStage, source: "fanout",
          },
          update: {},
        });
        seeded++;
      }
    }
  }

  // ---- 2. Coverage matching against the site coverage map ----
  const sitePages = await prisma.sitePage.findMany({ where: { companyId: company.id } });
  const corpus = sitePages.map((p, i) =>
    `P${i} [${p.contentType}] ${p.path} :: ${p.primaryTopic ?? ""} :: ${JSON.stringify(p.questionsAnswered ?? [])}`).join("\n");
  const nodes = await prisma.topicNode.findMany({ where: { companyId: company.id } });
  const MATCH_BATCH = 20;
  for (let i = 0; i < nodes.length; i += MATCH_BATCH) {
    const batch = nodes.slice(i, i + MATCH_BATCH);
    const res = await chatJson<{ matches: { index: number; status: "unanswered" | "answered_weak" | "answered_strong"; pageIndex: number | null }[] }>([
      { role: "system", content: "You judge whether a website already answers buyer questions. answered_strong = a page substantively and directly answers it; answered_weak = touched on but shallow/partial; unanswered = no page covers it. Reply JSON only." },
      { role: "user", content: `SITE PAGES:\n${corpus}\n\nQUESTIONS:\n${batch.map((n, j) => `Q${j}: ${n.question}`).join("\n")}\n\nReturn {"matches":[{"index":j,"status":"...","pageIndex":n-or-null}]}` },
    ], { companyId: company.id, tag: "coverage-match", maxTokens: 8000, temperature: 0.1 });
    for (const m of res.matches ?? []) {
      const node = batch[m.index];
      if (!node) continue;
      const page = m.pageIndex != null ? sitePages[m.pageIndex] : null;
      await prisma.topicNode.update({
        where: { id: node.id },
        data: { status: m.status, answeredByPageId: page?.id ?? null },
      });
    }
  }

  // ---- 3. LIVE evidence probes on the most promising gaps ----
  const candidates = await prisma.topicNode.findMany({
    where: { companyId: company.id, status: { in: ["unanswered", "answered_weak"] } },
  });
  const prelim = (n: (typeof candidates)[number]) =>
    (INTENT_W[n.funnelStage] ?? 0.7) * (n.category === "local" ? 1.2 : 1) * (n.status === "unanswered" ? 1 : 0.8);
  const probeTargets = candidates.sort((a, b) => prelim(b) - prelim(a)).slice(0, payload.liveProbeCount);

  const directoryDomains = new Map<string, number>();
  let probed = 0;
  for (const node of probeTargets) {
    try {
      const probe = await serpProbe(node.question, tenantHost, company.id);
      const competitorsCited = probe.aiOverviewDomains.filter((d) => d !== tenantHost.replace(/^www\./, ""));
      const weakness = probe.hasAiOverview ? (probe.tenantInAiOverview ? 0.2 : 0.9) : 0.6;
      const winnability = probe.tenantInOrganicTop10 ? 0.9 : 0.6;
      const demand = 0.5 + Math.min(0.5, probe.peopleAlsoAsk.length * 0.05);
      const score = demand * (INTENT_W[node.funnelStage] ?? 0.7) * 1.0 * weakness * winnability * 100;
      await prisma.topicNode.update({
        where: { id: node.id },
        data: {
          score,
          scoreParts: { demand, intent: INTENT_W[node.funnelStage] ?? 0.7, weakness, winnability },
          evidence: { ...probe, competitorsCited },
          status: probe.tenantInAiOverview ? "answered_strong" : node.status,
        },
      });
      for (const d of competitorsCited) {
        if (/reddit|clutch|cloudtango|yelp|upcity|g2\.com|expertise|designrush|goodfirms/.test(d)) {
          directoryDomains.set(d, (directoryDomains.get(d) ?? 0) + 1);
        }
      }
      // PAA questions become new graph nodes (source: paa)
      for (const paa of probe.peopleAlsoAsk.slice(0, 5)) {
        await prisma.topicNode.upsert({
          where: { companyId_locationId_verticalId_question: {
            companyId: company.id, locationId: node.locationId, verticalId: node.verticalId, question: paa,
          } as any },
          create: {
            companyId: company.id, locationId: node.locationId, verticalId: node.verticalId,
            question: paa, category: node.category, funnelStage: node.funnelStage, source: "paa",
          },
          update: {},
        });
      }
      probed++;
    } catch (e: any) {
      console.warn(`[analyze-gaps] probe failed for "${node.question}": ${e?.message}`);
    }
  }

  // heuristic scores for unprobed nodes so the whole backlog is ranked
  await Promise.all(candidates.filter((n) => !probeTargets.includes(n)).map((n) =>
    prisma.topicNode.update({ where: { id: n.id }, data: { score: prelim(n) * 40, scoreParts: { heuristic: true } } })));

  // ---- 4. Off-page tasks + snapshot ----
  for (const [domain, count] of directoryDomains) {
    const existing = await prisma.offPageTask.findFirst({ where: { companyId: company.id, source: domain, status: "open" } });
    if (!existing) {
      await prisma.offPageTask.create({
        data: {
          companyId: company.id, source: domain, priority: count,
          action: `Get ${company.name} listed/reviewed on ${domain} — AI engines cite it for buyer prompts where the company is absent`,
          evidence: { citedInProbes: count, runAt: runStartedAt.toISOString() },
        },
      });
    }
  }

  const [total, strong, weak, unanswered] = await Promise.all([
    prisma.topicNode.count({ where: { companyId: company.id } }),
    prisma.topicNode.count({ where: { companyId: company.id, status: "answered_strong" } }),
    prisma.topicNode.count({ where: { companyId: company.id, status: "answered_weak" } }),
    prisma.topicNode.count({ where: { companyId: company.id, status: "unanswered" } }),
  ]);
  const coveragePct = total ? Math.round((strong / total) * 1000) / 10 : 0;
  await prisma.visibilitySnapshot.create({
    data: {
      companyId: company.id, locationId: payload.locationId, verticalId: payload.verticalId,
      summary: { total, strong, weak, unanswered, coveragePct, probed, liveFetchedAt: runStartedAt.toISOString() },
    },
  });

  // legacy GapAnalysis row for API compat
  await prisma.gapAnalysis.create({
    data: {
      companyId: company.id, locationId: payload.locationId, verticalId: payload.verticalId,
      status: "complete", liveFetchedAt: runStartedAt,
      gaps: { total, unanswered, weak, coveragePct },
    },
  });

  console.log(`[analyze-gaps] ${company.name}: ${total} nodes (${seeded} seeded), coverage ${coveragePct}%, ${probed} live probes, ${directoryDomains.size} off-page targets`);
  return { status: "ok", companyId: company.id, total, coveragePct, probed };
}
