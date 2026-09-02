import type { Job } from "bullmq";
import { readFile } from "node:fs/promises";
import { ExtractDocumentPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";

interface ExtractedTestimonial {
  clientName: string | null;
  industry: string | null;
  location: string | null;
  quote: string;
  resultClaim: string | null;
  metrics: string[];
  services: string[];
  keywords: string[];
}

/**
 * One-time extraction: PDF -> individual Testimonial rows, each tagged with
 * industry/services/keywords so generation-time retrieval is deterministic
 * (plain keyword search, no AI, no shipping the whole book per article).
 */
export async function extractDocument(job: Job) {
  const payload = ExtractDocumentPayload.parse(job.data);
  const doc = await prisma.companyDocument.findUniqueOrThrow({ where: { id: payload.documentId } });
  await prisma.companyDocument.update({ where: { id: doc.id }, data: { status: "extracting" } });
  try {
    let text = "";
    if (doc.filename.toLowerCase().endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(await readFile(doc.filePath)) });
      const parsed = await parser.getText();
      text = parsed.text ?? "";
      await parser.destroy().catch(() => {});
    } else {
      text = await readFile(doc.filePath, "utf8");
    }
    text = text.replace(/\s+\n/g, "\n").trim();
    if (text.length < 50) throw new Error("no extractable text found in the document (is it a scanned/image PDF?)");

    // wipe previous extraction of this document (re-upload = re-extract)
    await prisma.testimonial.deleteMany({ where: { documentId: doc.id } });
    const source = /google|review/i.test(doc.kind) ? "google" : "book";

    const CHUNK = 12000;
    let inserted = 0;
    for (let i = 0; i < text.length; i += CHUNK) {
      const chunk = text.slice(i, i + CHUNK + 1500); // overlap so items spanning cuts survive
      const res = await chatJson<{ testimonials: ExtractedTestimonial[] }>([
        { role: "system", content: "You extract individual testimonials and client case examples from a document, verbatim. Never invent, merge, or embellish. Quote text exactly as written (light whitespace cleanup only). Tag each with normalized lowercase industry (e.g. dental, legal, construction, healthcare, accounting, nonprofit, manufacturing; null if unknown), the IT services it touches, and 5-10 search keywords (topics, problems, tools mentioned). Capture any concrete numbers as metrics strings. Reply JSON only." },
        { role: "user", content: `Extract every distinct testimonial/case example from this text. Skip duplicates of ones already covered by an earlier chunk if the text repeats.\n\nReturn {"testimonials":[{"clientName":string|null,"industry":string|null,"location":string|null,"quote":"exact text","resultClaim":string|null,"metrics":["..."],"services":["..."],"keywords":["..."]}]}\n\nTEXT:\n${chunk}` },
      ], { companyId: doc.companyId, tag: "extract-testimonials", maxTokens: 12000, temperature: 0.1 });
      for (const t of res.testimonials ?? []) {
        if (!t.quote || t.quote.length < 30) continue;
        // dedupe on quote prefix
        const dup = await prisma.testimonial.findFirst({
          where: { companyId: doc.companyId, quote: { startsWith: t.quote.slice(0, 60) } },
        });
        if (dup) continue;
        await prisma.testimonial.create({
          data: {
            companyId: doc.companyId, documentId: doc.id, source,
            clientName: t.clientName, industry: t.industry?.toLowerCase() ?? null,
            location: t.location, quote: t.quote, resultClaim: t.resultClaim,
            metrics: t.metrics ?? [], services: (t.services ?? []).map((s) => s.toLowerCase()),
            keywords: (t.keywords ?? []).map((k) => k.toLowerCase()),
          },
        });
        inserted++;
      }
    }
    await prisma.companyDocument.update({
      where: { id: doc.id },
      data: { status: "ready", extracted: { testimonialCount: inserted, textLength: text.length } },
    });
    console.log(`[extract-document] ${doc.filename}: ${inserted} testimonials extracted`);
    return { status: "ok", inserted };
  } catch (e: any) {
    await prisma.companyDocument.update({ where: { id: doc.id }, data: { status: "failed", error: String(e?.message ?? e).slice(0, 300) } });
    throw e;
  }
}
