/**
 * Full-drain orchestrator: generate every remaining gap article, wait for the
 * queue to finish, filter (QA pass + near-duplicate titles), then schedule
 * the batch across the next 30 days (any day, 08:00-17:00 site time) and
 * push everything to Octane's own scheduler.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../src/lib/prisma.js";

const API = "http://localhost:3101/api";
const companyId = "cmrtmgl980000vzv4yjymxueh";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 1. queue all remaining gaps
const q1 = await fetch(`${API}/companies/${companyId}/generate-next`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 150 }),
}).then((r) => r.json());
log("queued", q1.queued?.length, "articles for generation");

// 2. wait for the generate queue to drain
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63790", { maxRetriesPerRequest: null });
const genQ = new Queue("generate-blog", { connection });
for (;;) {
  const counts = await genQ.getJobCounts("waiting", "active", "delayed");
  const open = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  log("generation remaining:", open);
  if (open === 0) break;
  await new Promise((r) => setTimeout(r, 60000));
}
await genQ.close();
log("generation drained");

// 3. collect QA-passing drafts, filter near-duplicate titles
const norm = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter || 1);
};
const published = await prisma.blogPost.findMany({ where: { status: "published" }, select: { title: true } });
const seen = published.map((p) => norm(p.title));
const drafts = await prisma.blogPost.findMany({ where: { status: "draft" }, orderBy: { createdAt: "asc" } });
const pick: string[] = [];
let skippedQa = 0, skippedDup = 0;
for (const d of drafts) {
  const qa = d.qa as { pass?: boolean } | null;
  if (!qa?.pass) { skippedQa++; continue; }
  const t = norm(d.title);
  if (seen.some((s) => jaccard(t, s) > 0.65)) { skippedDup++; log("DUP skipped:", d.title.slice(0, 60)); continue; }
  seen.push(t);
  pick.push(d.id);
}
log(`drafts: ${drafts.length} | scheduling: ${pick.length} | qa-fail left in review: ${skippedQa} | near-dup left in review: ${skippedDup}`);

// 4. schedule across the next 30 days, 08:00-17:00, any day
const start = new Date();
start.setDate(start.getDate() + 1);
start.setHours(8, 0, 0, 0);
const end = new Date(start.getTime() + 30 * 24 * 3600e3);
const CHUNK = 40;
for (let i = 0; i < pick.length; i += CHUNK) {
  const res = await fetch(`${API}/companies/${companyId}/schedule-batch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postIds: pick.slice(i, i + CHUNK),
      start: new Date(start.getTime() + (i / pick.length) * 30 * 24 * 3600e3).toISOString(),
      end: new Date(start.getTime() + Math.min(1, (i + CHUNK) / pick.length) * 30 * 24 * 3600e3).toISOString(),
      perWeek: 14,
    }),
  }).then((r) => r.json());
  log("scheduled chunk:", res.scheduled?.length);
}
await connection.quit();
await prisma.$disconnect();
log("ORCHESTRATION COMPLETE — publish queue is pushing to Octane with future dates");
process.exit(0);
