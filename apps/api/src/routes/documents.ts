import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { getQueue, QUEUES } from "../lib/queues.js";

const UPLOAD_DIR = path.resolve(process.cwd(), "../../data/uploads");

/** Document upload (testimonial books etc.) -> extraction pipeline. */
export async function documentRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.post("/companies/:companyId/documents", async (req, reply) => {
    const { companyId } = req.params as { companyId: string };
    const file = await req.file();
    if (!file) return reply.code(422).send({ error: "no file uploaded" });
    const safeName = file.filename.replace(/[^\w.\-]+/g, "_");
    const dir = path.join(UPLOAD_DIR, companyId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${Date.now()}-${safeName}`);
    await pipeline(file.file, createWriteStream(filePath));
    const kindField = (file.fields?.kind as { value?: string } | undefined)?.value;
    const doc = await prisma.companyDocument.create({
      data: { companyId, filename: file.filename, filePath, kind: kindField ?? "testimonials" },
    });
    await getQueue(QUEUES.extractDocument).add(QUEUES.extractDocument, { companyId, documentId: doc.id }, { attempts: 3, backoff: { type: "exponential", delay: 30000 } });
    return reply.code(201).send({ ok: true, documentId: doc.id, status: "extracting" });
  });

  app.get("/companies/:companyId/documents", async (req) => {
    const { companyId } = req.params as { companyId: string };
    const docs = await prisma.companyDocument.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
    const testimonialCount = await prisma.testimonial.count({ where: { companyId } });
    return { documents: docs.map((d) => ({ id: d.id, filename: d.filename, kind: d.kind, status: d.status, error: d.error, createdAt: d.createdAt })), testimonialCount };
  });

  app.get("/companies/:companyId/testimonials", async (req) => {
    const { companyId } = req.params as { companyId: string };
    return prisma.testimonial.findMany({ where: { companyId }, orderBy: { createdAt: "desc" }, take: 300 });
  });
}
