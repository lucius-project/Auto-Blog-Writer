import { prisma } from "./prisma.js";
import { chatJson } from "./openrouter.js";

interface CoverageEntry {
  path?: string;
  title?: string;
  primaryTopic?: string;
  contentType?: string;
  questionsAnswered?: string[];
}

/**
 * Diff every listed competitor's coverage map against the tenant's Topic Graph
 * and seed the buyer questions competitors answer that the tenant is missing.
 *
 * Seeded nodes are company-wide (locationId: null) and tagged to a vertical —
 * the same convention analyzeGaps uses for location-agnostic taxonomy templates.
 * source: "competitor". Returns the number of nodes seeded.
 */
export async function seedCompetitorTopics(companyId: string): Promise<number> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { locations: { include: { verticals: true } }, competitors: true },
  });

  const competitors = company.competitors.filter((c) => Array.isArray(c.coverage) && (c.coverage as unknown[]).length);
  if (!competitors.length) return 0;

  // first verticalId seen per lowercased vertical name (company-wide representative)
  const verticalIdByName = new Map<string, string>();
  for (const loc of company.locations) {
    for (const v of loc.verticals) {
      const key = v.name.toLowerCase();
      if (!verticalIdByName.has(key)) verticalIdByName.set(key, v.id);
    }
  }
  const verticalNames = [...verticalIdByName.keys()];
  if (!verticalNames.length) return 0;

  // distinct competitor questions, with which domains cover each (cap to bound cost)
  const domainsByQuestion = new Map<string, Set<string>>();
  for (const c of competitors) {
    for (const entry of c.coverage as CoverageEntry[]) {
      for (const q of entry.questionsAnswered ?? []) {
        const key = q.trim();
        if (key.length < 8) continue;
        if (!domainsByQuestion.has(key)) domainsByQuestion.set(key, new Set());
        domainsByQuestion.get(key)!.add(c.domain);
      }
    }
  }
  const competitorQuestions = [...domainsByQuestion.keys()].slice(0, 400);
  if (!competitorQuestions.length) return 0;

  const existing = await prisma.topicNode.findMany({
    where: { companyId: company.id },
    select: { question: true },
  });

  const res = await chatJson<{
    topics: { question: string; vertical: string; category: string; funnelStage: string }[];
  }>([
    {
      role: "system",
      content:
        "You compare the buyer questions competitors' content answers against a company's existing topic graph. " +
        "Return ONLY questions that are (a) clearly relevant to at least one of the company's verticals and " +
        "(b) NOT already represented (semantically, not just verbatim) in the existing topics. " +
        "Rephrase each into a natural question an SMB buyer would ask an AI assistant. Reply JSON only.",
    },
    {
      role: "user",
      content:
        `COMPANY VERTICALS: ${verticalNames.join(", ")}\n\n` +
        `EXISTING TOPICS (do not duplicate or rephrase these):\n${existing.map((e) => e.question).join("\n")}\n\n` +
        `COMPETITOR QUESTIONS (candidates to add):\n${competitorQuestions.join("\n")}\n\n` +
        `Return {"topics":[{"question":"...","vertical":"one of the company verticals exactly","category":"service|pricing|comparison|cybersecurity|compliance|tools|operations|local|risk|selection","funnelStage":"awareness|consideration|decision|compliance"}]}`,
    },
  ], { companyId: company.id, tag: "competitor-topic-map", maxTokens: 12000, temperature: 0.3 });

  let seeded = 0;
  const seededDomains = new Set<string>();
  for (const t of res.topics ?? []) {
    const verticalId = verticalIdByName.get((t.vertical ?? "").toLowerCase());
    if (!verticalId || !t.question) continue;
    // best-effort attribution: domains that had a near-identical candidate question
    const domains = [...(domainsByQuestion.get(t.question) ?? [])];
    const attributed = domains.length
      ? domains
      : [...domainsByQuestion.entries()]
          .filter(([q]) => q.toLowerCase().slice(0, 30) === t.question.toLowerCase().slice(0, 30))
          .flatMap(([, d]) => [...d]);
    for (const d of attributed) seededDomains.add(d);
    try {
      // Prisma rejects null inside a compound-unique `where`, so dedupe with
      // findFirst (which accepts locationId: null) then create.
      const exists = await prisma.topicNode.findFirst({
        where: { companyId: company.id, locationId: null, verticalId, question: t.question },
        select: { id: true },
      });
      if (exists) continue;
      // give a provisional score so the topic ranks in backlog views right away
      // (a real gap check refines it with live evidence). Competitor-sourced =
      // a rival already covers this, so start it mid-high.
      const stageW: Record<string, number> = { decision: 1, compliance: 0.95, consideration: 0.85, awareness: 0.6 };
      const provisionalScore = 45 * (stageW[t.funnelStage] ?? 0.8);
      await prisma.topicNode.create({
        data: {
          companyId: company.id, locationId: null, verticalId,
          question: t.question, category: t.category || "service",
          funnelStage: t.funnelStage || "consideration", source: "competitor",
          score: provisionalScore, scoreParts: { provisional: true, from: "competitor" } as any,
          evidence: attributed.length ? { competitorDomains: attributed } : undefined,
        },
      });
      seeded++;
    } catch (e: any) {
      console.warn(`[competitor-topics] seed failed for "${t.question}": ${e?.message}`);
    }
  }

  // per-competitor gapsFound: how many of the topics we just added trace back
  // (by direct or fuzzy attribution) to this competitor's content. If the total
  // seeded is non-zero but attribution missed everything (LLM rephrased), split
  // the credit across the competitors that had candidate questions.
  const attributedCount = new Map<string, number>();
  for (const t of res.topics ?? []) {
    const domains = domainsByQuestion.get(t.question)
      ?? new Set([...domainsByQuestion.entries()]
        .filter(([q]) => q.toLowerCase().slice(0, 30) === t.question.toLowerCase().slice(0, 30))
        .flatMap(([, d]) => [...d]));
    for (const d of domains) attributedCount.set(d, (attributedCount.get(d) ?? 0) + 1);
  }
  const totalAttributed = [...attributedCount.values()].reduce((a, b) => a + b, 0);
  for (const c of competitors) {
    const contributed = [...domainsByQuestion.values()].filter((s) => s.has(c.domain)).length;
    const n = totalAttributed > 0
      ? (attributedCount.get(c.domain) ?? 0)
      : Math.round(seeded * (contributed / Math.max(1, [...domainsByQuestion.values()].reduce((a, s) => a + s.size, 0))));
    await prisma.competitor.update({ where: { id: c.id }, data: { gapsFound: n } }).catch(() => null);
  }

  console.log(`[competitor-topics] ${company.name}: ${seeded} topics seeded from ${competitors.length} competitor(s)`);
  return seeded;
}
