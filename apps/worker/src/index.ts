import { Worker } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@abw/shared";
import { ingestSite } from "./processors/ingestSite.js";
import { researchCompany } from "./processors/researchCompany.js";
import { analyzeGaps } from "./processors/analyzeGaps.js";
import { generateBlog } from "./processors/generateBlog.js";
import { publishBlog } from "./processors/publishBlog.js";
import { weeklyRun } from "./processors/weeklyRun.js";
import { extractDocument } from "./processors/extractDocument.js";
import { octaneKeepalive } from "./processors/octaneKeepalive.js";
import { writeSchedule } from "./processors/writeSchedule.js";
import { offpageDraft } from "./processors/offpageDraft.js";
import { syncAnalytics } from "./processors/syncAnalytics.js";
import { Queue } from "bullmq";

const connection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:63790",
  { maxRetriesPerRequest: null },
);

const workers = [
  new Worker(QUEUES.ingestSite, ingestSite, { connection }),
  new Worker(QUEUES.researchCompany, researchCompany, { connection }),
  new Worker(QUEUES.analyzeGaps, analyzeGaps, { connection }),
  new Worker(QUEUES.generateBlog, (job) => generateBlog(job), { connection, concurrency: 2 }),
  new Worker(QUEUES.publishBlog, publishBlog, { connection }),
  new Worker(QUEUES.weeklyRun, weeklyRun, { connection, lockDuration: 60 * 60 * 1000 }),
  new Worker(QUEUES.extractDocument, extractDocument, { connection, lockDuration: 30 * 60 * 1000 }),
  new Worker("octane-keepalive", octaneKeepalive, { connection }),
  new Worker(QUEUES.writeSchedule, writeSchedule, { connection, lockDuration: 10 * 60 * 1000 }),
  new Worker(QUEUES.offpageDraft, offpageDraft, { connection }),
  new Worker(QUEUES.syncAnalytics, syncAnalytics, { connection }),
];

for (const w of workers) {
  w.on("completed", (job) => console.log(`[${w.name}] completed ${job.id}`));
  w.on("failed", (job, err) =>
    console.error(`[${w.name}] failed ${job?.id}:`, err.message),
  );
}

// daily Octane session health check, 07:00 site time
const keepaliveQueue = new Queue("octane-keepalive", { connection });
keepaliveQueue.upsertJobScheduler("octane-keepalive-daily", { pattern: "0 7 * * *", tz: "America/Denver" }, { name: "octane-keepalive", data: {} })
  .catch((e) => console.warn("keepalive scheduler:", e?.message));

console.log(`abw-worker listening on queues: ${workers.map((w) => w.name).join(", ")}`);

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
