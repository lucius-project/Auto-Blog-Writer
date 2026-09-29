import type { Job } from "bullmq";
import { WeeklyRunPayload, DEFAULT_SETTINGS, QUEUES, checklistScore, type ChecklistItem } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { notify } from "../lib/notify.js";
import { getQueue } from "../lib/queues.js";
import { ingestSite } from "./ingestSite.js";
import { researchCompany } from "./researchCompany.js";
import { analyzeGaps } from "./analyzeGaps.js";
import { analyzeCompetitors } from "./analyzeCompetitors.js";
import { newsTopicsForCompany } from "../lib/feeds.js";
import { generateBlog } from "./generateBlog.js";
import { websiteChecklist } from "./websiteChecklist.js";

/**
 * The forever-loop tick. Runs weekly per tenant (BullMQ job scheduler):
 * re-ingest -> website checklist -> refresh research -> gap analysis (live)
 * -> generate top gaps within caps -> review queue (or auto-approve+stagger
 * when enabled).
 */
export async function weeklyRun(job: Job) {
  const payload = WeeklyRunPayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: payload.companyId } });
  const settings = { ...DEFAULT_SETTINGS, ...((company.settings as any) ?? {}) };
  if (settings.killSwitch) {
    console.warn(`[weekly-run] ${company.name}: kill switch is ON — skipping`);
    return { status: "kill_switch" };
  }

  const asJob = (data: unknown) => ({ data } as Job);
  await ingestSite(asJob({ companyId: company.id, maxPages: 80, force: false }));
  // no AI calls — re-check the site right after the fresh crawl; never blocks the run
  let checklistLine = "";
  try {
    await websiteChecklist(asJob({ companyId: company.id }));
    const row = await prisma.websiteChecklist.findUnique({ where: { companyId: company.id } });
    const manual = (row?.manual ?? {}) as Record<string, { done: boolean }>;
    const items = ((row?.items ?? []) as unknown as ChecklistItem[])
      .map((it) => (it.status === "manual" ? { ...it, done: manual[it.key]?.done ?? false } : it));
    if (items.length) checklistLine = ` Website checklist: ${checklistScore(items)}/100.`;
  } catch (e: any) {
    console.warn(`[weekly-run] website checklist: ${e?.message}`);
  }
  await researchCompany(asJob({ companyId: company.id, force: false }));
  await newsTopicsForCompany(company.id).catch((e) => console.warn(`[weekly-run] feeds: ${e?.message}`));
  try {
    await analyzeCompetitors(asJob({ companyId: company.id, maxPagesPerCompetitor: 50 }));
  } catch (e: any) {
    console.warn(`[weekly-run] competitor analysis: ${e?.message}`);
  }
  await analyzeGaps(asJob({ companyId: company.id, liveProbeCount: 12 }));

  // Freshness: published answers older than 90 days go stale for refresh
  const staleCutoff = new Date(Date.now() - 90 * 24 * 3600e3);
  await prisma.topicNode.updateMany({
    where: {
      companyId: company.id, status: "answered_strong",
      blogPostId: { not: null }, updatedAt: { lt: staleCutoff },
    },
    data: { status: "stale" },
  });

  // Drain the topic graph in priority order, within caps
  const candidates = await prisma.topicNode.findMany({
    where: { companyId: company.id, status: { in: ["unanswered", "answered_weak", "competitor_owned", "stale"] }, blogPostId: null },
    orderBy: [{ score: { sort: "desc", nulls: "last" } }],
    take: settings.weeklyCapTotal * 3,
  });
  const perPair = new Map<string, number>();
  let generated = 0;
  const results: { topicNodeId: string; blogPostId?: string; qaPass?: boolean }[] = [];
  for (const node of candidates) {
    if (generated >= settings.weeklyCapTotal) break;
    const pairKey = `${node.locationId}:${node.verticalId}`;
    if ((perPair.get(pairKey) ?? 0) >= settings.weeklyCapPerPair) continue;
    try {
      const r = (await generateBlog(asJob({ companyId: company.id, topicNodeId: node.id }))) as any;
      results.push({ topicNodeId: node.id, blogPostId: r.blogPostId, qaPass: r.qaPass });
      perPair.set(pairKey, (perPair.get(pairKey) ?? 0) + 1);
      generated++;
    } catch (e: any) {
      console.warn(`[weekly-run] generation failed for "${node.question}": ${e?.message}`);
    }
  }

  // Auto-approve path: QA-passing posts get staggered across the next 7 days
  let approved = 0;
  if (settings.autoApprove) {
    const passing = await prisma.blogPost.findMany({
      where: { companyId: company.id, status: "draft", id: { in: results.map((r) => r.blogPostId).filter(Boolean) as string[] } },
    });
    let dayOffset = 1;
    let prevTime = 0;
    for (const post of passing) {
      const qa = post.qa as any;
      if (!qa?.pass) continue;
      // stagger: one per day, random business hour, min random 36-62 min gap
      const when = new Date();
      when.setDate(when.getDate() + dayOffset);
      when.setHours(8 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60), 0, 0);
      const gap = (36 + Math.random() * 26) * 60e3;
      if (prevTime && when.getTime() < prevTime + gap) when.setTime(prevTime + gap);
      prevTime = when.getTime();
      await prisma.blogPost.update({ where: { id: post.id }, data: { status: "approved", scheduledFor: when } });
      await getQueue(QUEUES.publishBlog).add(QUEUES.publishBlog, { blogPostId: post.id }, { delay: Math.max(0, when.getTime() - Date.now()) });
      dayOffset++;
      approved++;
    }
  }

  const awaiting = generated - approved;
  await notify({
    companyId: company.id,
    type: awaiting > 0 ? "review_needed" : "weekly_done",
    title: `Weekly run: ${generated} new article${generated === 1 ? "" : "s"}` + (awaiting ? `, ${awaiting} awaiting review` : ""),
    body: (settings.autoApprove ? `${approved} auto-approved and scheduled.` : "Approve them in the review queue to schedule.") + checklistLine,
    href: awaiting ? `/review/${company.id}` : `/company/${company.id}`,
  });
  console.log(`[weekly-run] ${company.name}: generated ${generated}, auto-approved ${approved} (autoApprove=${settings.autoApprove})`);
  return { status: "ok", generated, approved, awaitingReview: generated - approved };
}
