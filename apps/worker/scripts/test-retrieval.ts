import { prisma } from "../src/lib/prisma.js";
import { relevantTestimonials } from "../src/lib/retrieval.js";
async function main() {
  const ts = await prisma.testimonial.findMany({});
  for (const t of ts) console.log("-", t.industry, "|", JSON.stringify(t.keywords.slice(0, 5)), "|", t.quote.slice(0, 60));
  const cid = "cmrtmgl980000vzv4yjymxueh";
  const r = await relevantTestimonials(cid, { question: "What happens if a healthcare & dental business fails HIPAA compliance?", category: "compliance", verticalName: "Healthcare & Dental" });
  console.log("HIPAA question ->", r.length, "retrieved:", r.map((t) => (t.clientName ?? "?") + " / " + (t.industry ?? "?")));
  const r2 = await relevantTestimonials(cid, { question: "How much does VoIP cost for a construction business?", category: "pricing", verticalName: "Construction" });
  console.log("VoIP/construction question ->", r2.length, "retrieved");
  await prisma.$disconnect();
  process.exit(0);
}
main();
