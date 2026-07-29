import { prisma } from "../src/lib/prisma.js";
import { extractDocument } from "../src/processors/extractDocument.js";
async function main() {
  const doc = await prisma.companyDocument.findFirstOrThrow({ where: { status: "failed" }, orderBy: { createdAt: "desc" } });
  console.log("retrying:", doc.filename);
  const res = await extractDocument({ data: { companyId: doc.companyId, documentId: doc.id } } as any);
  console.log(JSON.stringify(res));
  const count = await prisma.testimonial.count({ where: { companyId: doc.companyId } });
  const sample = await prisma.testimonial.findMany({ where: { documentId: doc.id }, take: 4 });
  console.log("total testimonials:", count);
  for (const t of sample) console.log("-", t.industry ?? "?", "|", (t.clientName ?? "?").slice(0, 30), "|", t.quote.slice(0, 70));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
