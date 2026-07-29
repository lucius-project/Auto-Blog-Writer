import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
// last scheduled slot of the finished batch
const last = await prisma.blogPost.findFirst({
  where: { batchRunId: "cmru9ifzw0000vzyx5m8prznc", scheduledFor: { not: null } },
  orderBy: { scheduledFor: "desc" },
});
let prev = last?.scheduledFor?.getTime() ?? Date.now();
const drafts = await prisma.blogPost.findMany({
  where: { status: { in: ["draft", "review"] }, scheduledFor: null },
  orderBy: { createdAt: "asc" },
});
for (const d of drafts) {
  const when = new Date(prev + (36 + Math.random() * 26) * 60e3);
  if (when.getHours() >= 17) { when.setDate(when.getDate() + 1); when.setHours(8, when.getMinutes(), 0, 0); }
  if (when.getHours() < 8) when.setHours(8 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 60), 0, 0);
  prev = when.getTime();
  await prisma.blogPost.update({ where: { id: d.id }, data: { scheduledFor: when } });
  console.log(d.title.slice(0, 55), "->", when.toString());
}
await prisma.$disconnect();
