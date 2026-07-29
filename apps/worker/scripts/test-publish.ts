import { prisma } from "../src/lib/prisma.js";
import { publishBlog } from "../src/processors/publishBlog.js";

async function main() {
  const post = await prisma.blogPost.findFirstOrThrow({ where: { slug: { contains: "hipaa" } } });
  await prisma.blogPost.update({ where: { id: post.id }, data: { status: "approved", scheduledFor: null } });
  console.log("publishing:", post.title);
  const res = await publishBlog({ data: { blogPostId: post.id } } as any).catch((e) => ({ error: e.message }));
  console.log(JSON.stringify(res, null, 1));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
