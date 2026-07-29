// Live Phase 1 proof: ingest + research 911it.com
import { prisma } from "../src/lib/prisma.js";
import { ingestSite } from "../src/processors/ingestSite.js";
import { researchCompany } from "../src/processors/researchCompany.js";

async function main() {
  let company = await prisma.company.findFirst({ where: { url: { contains: "911it.com" } } });
  if (!company) {
    company = await prisma.company.create({ data: { name: "911 IT", url: "https://www.911it.com" } });
  }
  let loc = await prisma.location.findFirst({ where: { companyId: company.id, city: "Salt Lake City" } });
  if (!loc) {
    loc = await prisma.location.create({ data: { companyId: company.id, name: "Salt Lake City HQ", city: "Salt Lake City", state: "UT" } });
  }
  for (const [name, slug] of [["Healthcare & Dental", "healthcare"], ["Construction", "construction"]] as const) {
    const existing = await prisma.vertical.findFirst({ where: { locationId: loc.id, slug } });
    if (!existing) await prisma.vertical.create({ data: { locationId: loc.id, name, slug } });
  }

  console.log("=== INGEST ===");
  const ing = await ingestSite({ data: { companyId: company.id, maxPages: 40, force: false } } as any);
  console.log(JSON.stringify(ing));

  console.log("=== RESEARCH ===");
  const res = await researchCompany({ data: { companyId: company.id, force: true } } as any);
  console.log(JSON.stringify(res));

  const byType = await prisma.sitePage.groupBy({ by: ["contentType"], where: { companyId: company.id }, _count: true });
  console.log("coverage:", JSON.stringify(byType));
  const c2 = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
  console.log("audit:", JSON.stringify(c2.siteAudit));
  const prof = c2.profile as any;
  console.log("differentiators:", JSON.stringify(prof?.differentiators));
  console.log("unknownsToAskOwner:", JSON.stringify(prof?.unknownsToAskOwner));
  const v = await prisma.vertical.findFirst({ where: { slug: "healthcare" } });
  console.log("healthcare buyerQuestions sample:", JSON.stringify(((v?.profile as any)?.buyerQuestions ?? []).slice(0, 5)));
  const sample = await prisma.sitePage.findMany({ where: { companyId: company.id, contentType: "service" }, take: 2 });
  for (const p of sample) console.log("page:", p.path, "topic:", p.primaryTopic, "q:", JSON.stringify(p.questionsAnswered).slice(0, 200));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
