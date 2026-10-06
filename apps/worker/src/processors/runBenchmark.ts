import type { Job } from "bullmq";
import { RunBenchmarkPayload, scoreDomain, normDomain, toBenchmarkRow, isBenchmarkRunLive } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { serpProbe, serpLocationFor, type SerpWhere } from "../lib/dataforseo.js";
import { notify } from "../lib/notify.js";

const CONCURRENCY = 2;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Competitive benchmark run: every active BenchmarkQuery is searched LIVE
 * from its own city (organic top 20 + map pack + AI Overview), stamped with
 * liveFetchedAt from the actual fetch. Nothing is reused from earlier runs.
 */
export async function runBenchmark(job: Job) {
  const payload = RunBenchmarkPayload.parse(job.data);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: payload.companyId },
    include: { locations: true, competitors: { select: { domain: true } } },
  });
  const running = await prisma.benchmarkRun.findMany({ where: { companyId: company.id, status: "running" } });
  const live = running.find(isBenchmarkRunLive);
  if (live) return { status: "already_running", runId: live.id };
  // no heartbeat for BENCHMARK_STALE_MS: the worker died mid-run — close it out
  for (const r of running) {
    await prisma.benchmarkRun.update({
      where: { id: r.id },
      data: { status: "failed", finishedAt: r.updatedAt, error: `interrupted after ${r.queriesProbed}/${r.queriesTotal} searches (worker stopped mid-run)` },
    });
  }

  // resume: probe only the searches an earlier run is missing (failed probes)
  const resume = payload.resumeRunId
    ? await prisma.benchmarkRun.findFirst({ where: { id: payload.resumeRunId, companyId: company.id } })
    : null;
  if (payload.resumeRunId && !resume) return { status: "run_not_found" };
  const done = resume
    ? new Set((await prisma.benchmarkResult.findMany({ where: { runId: resume.id }, select: { queryId: true } })).map((r) => r.queryId))
    : new Set<string>();
  const queries = (await prisma.benchmarkQuery.findMany({ where: { companyId: company.id, active: true } }))
    .filter((q) => !done.has(q.id));
  if (!queries.length) return { status: "no_queries" };
  const run = resume
    ? await prisma.benchmarkRun.update({ where: { id: resume.id }, data: { status: "running", error: null } })
    : await prisma.benchmarkRun.create({ data: { companyId: company.id, queriesTotal: queries.length } });

  try {
    const whereByLocation = new Map<string, SerpWhere>();
    for (const loc of company.locations) whereByLocation.set(loc.id, await serpLocationFor(loc));
    const tenantHost = new URL(company.url).hostname;

    let probed = done.size, failed = 0, next = 0;
    // DataForSEO intermittently returns "Internal SE Server Error" / uncharged
    // partial results: retry with backoff, then a slower second pass
    const probe = async (q: (typeof queries)[number], where: SerpWhere) => {
      for (let attempt = 0; ; attempt++) {
        try { return await serpProbe(q.query, tenantHost, company.id, where); } catch (e) {
          if (attempt >= 2) throw e;
          await pause(3000 * (attempt + 1));
        }
      }
    };
    const retryLater: typeof queries = [];
    const worker = async (list: typeof queries, deferFailures: boolean) => {
      while (next < list.length) {
        const q = list[next++]!;
        const where = whereByLocation.get(q.locationId);
        if (!where) { failed++; continue; }
        try {
          const p = await probe(q, where);
          await prisma.benchmarkResult.create({
            data: {
              runId: run.id, companyId: company.id, queryId: q.id, locationId: q.locationId, verticalId: q.verticalId,
              query: q.query, intent: q.intent, liveFetchedAt: new Date(p.liveFetchedAt),
              organic: p.organicRanked, localPack: p.localPack, aiOverview: p.aiOverviewDomains, hasAiOverview: p.hasAiOverview,
            },
          });
          probed++;
        } catch (e: any) {
          if (deferFailures) retryLater.push(q);
          else { failed++; console.warn(`[run-benchmark] "${q.query}" failed: ${e?.message}`); }
        }
        // every probe, success or not: live progress + the run's heartbeat
        await prisma.benchmarkRun.update({ where: { id: run.id }, data: { queriesProbed: probed } });
        await job.updateProgress({ probed, failed, deferred: retryLater.length, total: run.queriesTotal }).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queries, true)));
    if (retryLater.length) {
      await pause(30000);
      next = 0;
      await worker(retryLater, false);
    }
    if (!probed) throw new Error(`all ${failed} live probes failed`);

    const results = await prisma.benchmarkResult.findMany({ where: { runId: run.id } });
    const rows = results.map(toBenchmarkRow);
    const tenant = normDomain(tenantHost);
    const summary = {
      tenant: scoreDomain(rows, tenant),
      competitors: company.competitors.map((c) => scoreDomain(rows, c.domain, tenant)).sort((a, b) => b.score - a.score),
      failed,
    };
    await prisma.benchmarkRun.update({
      where: { id: run.id },
      data: { status: "complete", finishedAt: new Date(), queriesProbed: probed, summary: summary as any },
    });
    const leader = summary.competitors[0];
    await notify({
      companyId: company.id, type: "info",
      title: `Competitive benchmark done: you ${summary.tenant.score}${leader ? ` vs ${leader.domain} ${leader.score}` : ""}`,
      body: `${probed} live searches${failed ? ` (${failed} failed)` : ""}.`,
      href: `/company/${company.id}/competitors`,
    });
    console.log(`[run-benchmark] ${company.name}: ${probed} probed, ${failed} failed, tenant score ${summary.tenant.score}`);
    return { status: "ok", runId: run.id, probed, failed };
  } catch (e: any) {
    await prisma.benchmarkRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: String(e?.message ?? e).slice(0, 300) },
    });
    throw e;
  }
}
