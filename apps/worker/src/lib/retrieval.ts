import { prisma } from "./prisma.js";
import type { Testimonial } from "@prisma/client";

const STOP = new Set(["the","a","an","and","or","for","to","of","in","on","is","are","what","how","why","do","does","my","your","business","businesses","company","it"]);

function terms(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Deterministic testimonial retrieval — NO AI call. Scores every stored
 * testimonial by industry match + keyword/text overlap with the article's
 * question. Candidates that clear a relevance bar are then re-ranked with a
 * rotation penalty (recently/often-used quotes sink) plus a small random
 * jitter, so drafts cite a spread of different clients instead of repeating
 * the single best match every time. Hundreds of rows score in milliseconds.
 */
export async function relevantTestimonials(
  companyId: string,
  opts: { question: string; category?: string; verticalName?: string | null; take?: number },
): Promise<Testimonial[]> {
  const all = await prisma.testimonial.findMany({ where: { companyId } });
  if (!all.length) return [];
  const qTerms = new Set([...terms(opts.question), ...(opts.category ? terms(opts.category) : [])]);
  const vertical = (opts.verticalName ?? "").toLowerCase();
  const now = Date.now();
  const scored = all.map((t) => {
    let base = 0;
    if (t.industry && vertical && (vertical.includes(t.industry) || t.industry.includes(vertical.split(" ")[0] ?? ""))) base += 5;
    for (const k of t.keywords) if (qTerms.has(k) || [...qTerms].some((q) => k.includes(q))) base += 2;
    for (const s of t.services) if ([...qTerms].some((q) => s.includes(q))) base += 1.5;
    const bodyTerms = new Set(terms(`${t.quote} ${t.resultClaim ?? ""}`));
    for (const q of qTerms) if (bodyTerms.has(q)) base += 0.5;
    if ((t.metrics as string[] | null)?.length) base += 1; // numbers make better grounding

    // rotation penalty: how much this quote has already been leaned on. Kept
    // below the industry-match bonus (5) so a strongly-relevant used quote can
    // still beat a weakly-relevant fresh one, but two similar matches alternate.
    let penalty = Math.min(2.5, (t.usedCount ?? 0) * 0.4);
    if (t.lastUsedAt) {
      const days = (now - new Date(t.lastUsedAt).getTime()) / 86400e3;
      if (days < 21) penalty += (21 - days) / 15; // up to +1.4 for a just-used quote
    }
    const jitter = Math.random() * 1.1;
    return { t, base, adj: base - penalty + jitter };
  });
  // keep anything with real relevance; if nothing is relevant, fall back to the
  // least-used quotes so a generic article still gets fresh social proof
  let pool = scored.filter((x) => x.base > 0);
  if (!pool.length) pool = scored;
  return pool.sort((a, b) => b.adj - a.adj).slice(0, opts.take ?? 4).map((x) => x.t);
}

/** Mark the testimonials that actually made it into a draft, so the next
 * article rotates to different clients. Match is by id. */
export async function markTestimonialsUsed(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await prisma.testimonial.updateMany({
    where: { id: { in: ids } },
    data: { usedCount: { increment: 1 }, lastUsedAt: new Date() },
  });
}
