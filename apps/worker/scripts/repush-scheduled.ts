// Drain the delayed publish jobs and re-enqueue immediately: each post pushes
// to Octane now, carrying its future publish date (Octane releases it).
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../src/lib/prisma.js";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63790", { maxRetriesPerRequest: null });
const q = new Queue("publish-blog", { connection });
const delayed = await q.getDelayed();
console.log("delayed jobs to drain:", delayed.length);
for (const j of delayed) await j.remove();
const approved = await prisma.blogPost.findMany({ where: { status: "approved" }, orderBy: { scheduledFor: "asc" } });
console.log("approved posts to push now:", approved.length);
for (const post of approved) {
  await q.add("publish-blog", { blogPostId: post.id });
}
await q.close();
await connection.quit();
await prisma.$disconnect();
console.log("re-enqueued for immediate push with CMS-side scheduling");
process.exit(0);
