import { prisma } from "./prisma.js";
import type { Testimonial } from "@prisma/client";

const STOP = new Set(["the","a","an","and","or","for","to","of","in","on","is","are","what","how","why","do","does","my","your","business","businesses","company","it"]);

function terms(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Deterministic testimonial retrieval — NO AI call. Rotation across the
 * WHOLE testimonial library: only the least-recently-used slice ("due"
 * window) is eligible, and relevance (industry match + keyword/text overlap
 * with the article's question) picks the best fit within it, weighed against
 * queue position so the longest-waiting client always gets its turn. Every
 * client comes up in turn — relevance can't pin one star quote to every
 * article in a vertical. Returns the chosen example first.
 *
 * The first pick is reserved (lastUsedAt = now) immediately so articles
 * generated in parallel in the same batch rotate to different clients.
 */
export async function relevantTestimonials(
  companyId: string,
  opts: { question: string; category?: string; verticalName?: string | null; take?: number },
): Promise<Testimonial[]> {
  const all = await prisma.testimonial.findMany({ where: { companyId } });
  if (!all.length) return [];
  const take = opts.take ?? 2;
  const qTerms = new Set([...terms(opts.question), ...(opts.category ? terms(opts.category) : [])]);
  const vertical = (opts.verticalName ?? "").toLowerCase();
  const relevance = (t: Testimonial) => {
    let base = 0;
    if (t.industry && vertical && (vertical.includes(t.industry) || t.industry.includes(vertical.split(" ")[0] ?? ""))) base += 5;
    for (const k of t.keywords) if (qTerms.has(k) || [...qTerms].some((q) => k.includes(q))) base += 2;
    for (const s of t.services) if ([...qTerms].some((q) => s.includes(q))) base += 1.5;
    const bodyTerms = new Set(terms(`${t.quote} ${t.resultClaim ?? ""}`));
    for (const q of qTerms) if (bodyTerms.has(q)) base += 0.5;
    if ((t.metrics as string[] | null)?.length) base += 1; // numbers make better grounding
    return base;
  };

  // least-recently-used first (never-used before everything); random among ties
  const byStaleness = all
    .map((t) => ({ t, last: t.lastUsedAt ? new Date(t.lastUsedAt).getTime() : 0, r: Math.random() }))
    .sort((a, b) => a.last - b.last || a.r - b.r)
    .map((x) => x.t);
  const windowSize = Math.min(all.length, Math.max(take * 2, 6));
  const due = byStaleness.slice(0, windowSize);

  // relevance picks within the window, but each step closer to the front of
  // the queue is worth 1.5 points — so a client nobody's topic matches still
  // reaches the front and gets used instead of being passed over forever
  const picked = due
    .map((t, idx) => ({ t, score: relevance(t) - idx * 1.5 + Math.random() * 1.1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, take)
    .map((x) => x.t);

  if (picked[0]) {
    await prisma.testimonial.update({ where: { id: picked[0].id }, data: { lastUsedAt: new Date() } });
  }
  return picked;
}

/** Whole-word, case-sensitive first-name match ("Don" must not match "Don't"; "Luigi's" still counts). */
export function mentionsClient(text: string, clientName: string | null): boolean {
  const first = (clientName ?? "").trim().split(/\s+/)[0] ?? "";
  if (first.length < 3) return false;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\w)${esc}(?!\\w|['’]t\\b)`).test(text);
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
