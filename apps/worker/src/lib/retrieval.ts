import { prisma } from "./prisma.js";
import type { Testimonial } from "@prisma/client";

const STOP = new Set(["the","a","an","and","or","for","to","of","in","on","is","are","what","how","why","do","does","my","your","business","businesses","company","it"]);

function terms(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Deterministic testimonial retrieval — NO AI call. Scores every stored
 * testimonial by industry match + keyword/text overlap with the article's
 * question, returns the top N. Hundreds of rows score in milliseconds.
 */
export async function relevantTestimonials(
  companyId: string,
  opts: { question: string; category?: string; verticalName?: string | null; take?: number },
): Promise<Testimonial[]> {
  const all = await prisma.testimonial.findMany({ where: { companyId } });
  if (!all.length) return [];
  const qTerms = new Set([...terms(opts.question), ...(opts.category ? terms(opts.category) : [])]);
  const vertical = (opts.verticalName ?? "").toLowerCase();
  const scored = all.map((t) => {
    let score = 0;
    if (t.industry && vertical && (vertical.includes(t.industry) || t.industry.includes(vertical.split(" ")[0] ?? ""))) score += 5;
    for (const k of t.keywords) if (qTerms.has(k) || [...qTerms].some((q) => k.includes(q))) score += 2;
    for (const s of t.services) if ([...qTerms].some((q) => s.includes(q))) score += 1.5;
    const bodyTerms = new Set(terms(`${t.quote} ${t.resultClaim ?? ""}`));
    for (const q of qTerms) if (bodyTerms.has(q)) score += 0.5;
    if ((t.metrics as string[] | null)?.length) score += 1; // numbers make better grounding
    return { t, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, opts.take ?? 4).map((x) => x.t);
}
