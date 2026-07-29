import { prisma } from "../src/lib/prisma.js";
import { generateBlog } from "../src/processors/generateBlog.js";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ where: { url: { contains: "911it.com" } } });
  const node = await prisma.topicNode.findFirstOrThrow({
    where: { companyId: company.id, status: "unanswered", blogPostId: null, category: "compliance" },
    orderBy: { score: "desc" },
  });
  console.log("generating for:", node.question);
  const res = await generateBlog({ data: { companyId: company.id, topicNodeId: node.id } } as any);
  console.log(JSON.stringify(res));
  const post = await prisma.blogPost.findUniqueOrThrow({ where: { id: (res as any).blogPostId } });
  const seo = post.seo as any;
  const qa = post.qa as any;
  console.log("title:", post.title);
  console.log("slug:", post.slug);
  console.log("metaTitle:", seo.metaTitle);
  console.log("metaDescription:", seo.metaDescription);
  console.log("words:", post.bodyHtml.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length);
  console.log("faqs:", seo.faqs.length, "| internalLinks:", JSON.stringify(seo.internalLinks));
  console.log("QA:", qa.pass ? "PASS" : "FAIL");
  for (const gate of qa.gates.filter((x: any) => !x.ok)) console.log("  gate fail:", gate.name, gate.detail ?? "", gate.required ? "(required)" : "(flag)");
  console.log("--- first 600 chars of body ---");
  console.log(post.bodyHtml.slice(0, 600));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
