/**
 * QA / anti-slop gates. A draft must pass every REQUIRED gate to reach the
 * review queue; failed gates either block or flag for human attention.
 */

export interface QaResult {
  pass: boolean;
  gates: { name: string; ok: boolean; required: boolean; detail?: string }[];
}

const FLUFF = [
  "in today's fast-paced world", "in today's digital age", "it's important to note",
  "in conclusion", "at the end of the day", "game-changer", "unlock the power",
  "look no further", "in the ever-evolving", "digital landscape",
];

/**
 * StoryBrand "sea of sameness": claims every IT/MSP site makes. They describe
 * the vendor, not the reader, so they can't differentiate anyone.
 */
const SAMENESS = [
  "one-stop shop", "full-service", "cutting-edge", "state-of-the-art", "best-in-class",
  "world-class", "industry-leading", "leading provider", "second to none", "top-notch",
  "we pride ourselves", "trusted partner", "tailored solutions", "comprehensive solutions",
  "end-to-end solutions", "robust solutions", "innovative solutions", "we are passionate",
];

export const META_DESCRIPTION_MAX = 155;

const DANGLING = /\s+(?:and|or|but|with|for|to|of|in|on|at|by|the|a|an|plus|including)$/i;

/**
 * Deterministically fit a meta description to META_DESCRIPTION_MAX: models
 * miscount characters, so the repair loop can't be trusted with this. Cuts at
 * the last sentence end, else the last clause (comma), else the last word —
 * whichever keeps >= 70 chars — and drops dangling connectives ("…, and").
 */
export function fitMetaDescription(desc: string, max = META_DESCRIPTION_MAX): string {
  const d = desc.replace(/\s+/g, " ").trim();
  if (d.length <= max) return d;
  const head = d.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentenceEnd + 1 >= 70) return head.slice(0, sentenceEnd + 1);
  const clause = head.lastIndexOf(",");
  let cut = clause >= 70 ? head.slice(0, clause) : head.slice(0, max - 1).replace(/\s+\S*$/, "");
  for (let prev = ""; prev !== cut; ) {
    prev = cut;
    cut = cut.replace(/[\s,;:\-–—]+$/, "").replace(DANGLING, "");
  }
  return `${cut}.`;
}

export function runQaGates(article: {
  title: string; metaTitle: string; metaDescription: string; slug: string;
  bodyHtml: string; faqs: { q: string; a: string }[]; jsonLd: unknown;
  internalLinks: string[];
}, opts: { companyName?: string } = {}): QaResult {
  const gates: QaResult["gates"] = [];
  const g = (name: string, ok: boolean, required = true, detail?: string) =>
    gates.push({ name, ok, required, detail });
  const html = article.bodyHtml;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);

  // body carries no h1 — the CMS renders the title as the page h1
  g("no_h1_in_body", !/<h1[\s>]/i.test(html));

  // answer block: first <p>, 30-80 words, contains a number
  const firstP = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
  const firstPText = firstP.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const fpWords = firstPText.split(/\s+/).filter(Boolean).length;
  g("answer_block_length", fpWords >= 30 && fpWords <= 90, true, `${fpWords} words`);
  g("answer_block_has_number", /\d/.test(firstPText));

  // question-shaped H2s
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());
  g("h2_count", h2s.length >= 4 && h2s.length <= 9, true, `${h2s.length} h2s`);
  g("question_shaped_h2s", h2s.filter((h) => /\?|^how |^what |^why |^which |^when |^who /i.test(h)).length >= 3);

  // heading hierarchy: no h4+ without h3, no skipped levels
  const levels = [...html.matchAll(/<h([2-6])[^>]*>/gi)].map((m) => Number(m[1]));
  let seq = true;
  let prev = 1;
  for (const l of levels) { if (l > prev + 1) { seq = false; break; } prev = l; }
  g("sequential_headings", seq);

  g("word_count", words.length >= 1100, true, `${words.length} words`);
  g("has_list_or_table", /<[uo]l[\s>]|<table[\s>]/i.test(html));
  g("faq_count", article.faqs.length >= 4 && article.faqs.length <= 8, true, `${article.faqs.length} faqs`);
  g("faq_answer_lengths", article.faqs.every((f) => {
    const n = f.a.split(/\s+/).filter(Boolean).length; return n >= 20 && n <= 90;
  }));

  // JSON-LD: valid object, includes FAQPage mirroring the faqs
  let ld: any = article.jsonLd;
  let ldOk = false;
  try {
    if (typeof ld === "string") ld = JSON.parse(ld);
    const graph = ld["@graph"] ?? [ld];
    const faqPage = graph.find((x: any) => x["@type"] === "FAQPage");
    const blogPosting = graph.find((x: any) => x["@type"] === "BlogPosting" || x["@type"] === "Article");
    ldOk = Boolean(faqPage && blogPosting && (faqPage.mainEntity?.length ?? 0) >= Math.min(4, article.faqs.length));
  } catch { ldOk = false; }
  g("jsonld_valid", ldOk);

  g("meta_title_length", article.metaTitle.length >= 25 && article.metaTitle.length <= 65, true, `${article.metaTitle.length} chars`);
  g("meta_description_length", article.metaDescription.length >= 70 && article.metaDescription.length <= META_DESCRIPTION_MAX, true, `${article.metaDescription.length} chars`);
  g("slug_format", /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug));
  g("internal_links", article.internalLinks.length >= 2 && article.internalLinks.every((l) => l.startsWith("/")), true, `${article.internalLinks.length} links`);

  const fluffHits = FLUFF.filter((f) => text.toLowerCase().includes(f));
  g("no_fluff_phrases", fluffHits.length === 0, true, fluffHits.join("; "));

  const samenessHits = SAMENESS.filter((f) => text.toLowerCase().includes(f));
  g("no_sameness_phrases", samenessHits.length === 0, true, samenessHits.join("; "));

  // StoryBrand: the reader is the hero — "you" must clearly outweigh the
  // company talking about itself (lowercase "us" only, so "US" isn't counted)
  const youCount = (text.match(/\b[Yy]ou(?:r|rs|rself|rselves)?\b/g) ?? []).length;
  const nameCount = opts.companyName
    ? text.toLowerCase().split(opts.companyName.toLowerCase()).length - 1
    : 0;
  const weCount = (text.match(/\b(?:[Ww]e|[Oo]urs?|us)\b/g) ?? []).length + nameCount;
  g("reader_focus", youCount >= 15 && youCount >= weCount * 2, true, `you/your ${youCount} vs we/our/company ${weCount} (need >=15 and >=2x)`);

  // StoryBrand plan: a simple numbered path to working together
  const olItems = (html.match(/<ol[\s>][\s\S]*?<\/ol>/i)?.[0].match(/<li[\s>]/gi) ?? []).length;
  g("storybrand_plan_flag", olItems >= 3, false, olItems ? `${olItems}-step plan` : "no numbered plan");

  // flags (non-blocking): unresolved owner placeholders must be reviewed
  const placeholders = [...html.matchAll(/\[OWNER:[^\]]*\]/g)].length;
  g("owner_placeholders_flag", placeholders === 0, false, `${placeholders} placeholders need human fill-in`);

  return { pass: gates.every((x) => x.ok || !x.required), gates };
}
