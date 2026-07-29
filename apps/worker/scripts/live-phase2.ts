import { prisma } from "../src/lib/prisma.js";
import { analyzeGaps } from "../src/processors/analyzeGaps.js";
import { accountBalance } from "../src/lib/dataforseo.js";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { url: { contains: "911it.com" } } });
  console.log("balance before:", await accountBalance());
  const res = await analyzeGaps({ data: { companyId: company.id, liveProbeCount: 6 } } as any);
  console.log(JSON.stringify(res));
  const top = await prisma.topicNode.findMany({
    where: { companyId: company.id, status: { in: ["unanswered", "answered_weak"] } },
    orderBy: { score: "desc" }, take: 8,
  });
  for (const n of top) {
    const ev = n.evidence as any;
    console.log(`#${Math.round(n.score ?? 0)} [${n.status}] ${n.question}` + (ev ? ` | aiOverview=${ev.hasAiOverview} tenantIn=${ev.tenantInAiOverview} cited=${(ev.competitorsCited ?? []).slice(0, 4).join(",")}` : " | heuristic"));
  }
  const tasks = await prisma.offPageTask.findMany({ where: { companyId: company.id } });
  console.log("offpage:", tasks.map((t) => t.source).join(", ") || "none");
  const snap = await prisma.visibilitySnapshot.findFirst({ where: { companyId: company.id }, orderBy: { capturedAt: "desc" } });
  console.log("snapshot:", JSON.stringify(snap?.summary));
  const spend = await prisma.dataFetchLog.aggregate({ where: { provider: "dataforseo" }, _sum: { cost: true } });
  console.log("dataforseo spend so far: $", spend._sum.cost);
  console.log("balance after:", await accountBalance());
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
