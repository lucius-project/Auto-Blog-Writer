import type { Job } from "bullmq";
import { GenerateBlogPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";
import { runQaGates } from "../lib/qa.js";
import { relevantTestimonials, markTestimonialsUsed } from "../lib/retrieval.js";
import { countryName } from "../lib/taxonomy.js";

interface DraftJson {
  title: string;
  metaTitle: string;
  metaDescription: string;
  slug: string;
  bodyHtml: string;
  faqs: { q: string; a: string }[];
  internalLinks: string[];
}

/**
 * Stage 4 — Article generation, per the content contract (docs/PLAN.md §4):
 * grounding -> draft -> self-critique -> QA gates -> BlogPost (status=draft)
 * ready for the review queue. Never invents specifics: unknown facts become
 * [OWNER: ...] placeholders that flag for human fill-in.
 */
export async function generateBlog(job: Job, onStep?: (step: string) => Promise<void> | void) {
  const step = async (name: string) => { try { await onStep?.(name); } catch { /* progress only */ } };
  const payload = GenerateBlogPayload.parse(job.data);
  await step("grounding");
  const node = await prisma.topicNode.findUniqueOrThrow({ where: { id: payload.topicNodeId } });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: payload.companyId } });
  const refreshPost = payload.refreshPostId
    ? await prisma.blogPost.findUniqueOrThrow({ where: { id: payload.refreshPostId } })
    : null;
  if (node.blogPostId && !refreshPost) return { status: "already_generated", blogPostId: node.blogPostId };
  // per-post cost accounting: new posts don't exist yet, so calls carry a
  // correlation ref that gets attributed to the post right after creation
  const costRef = `gen-${node.id}-${Date.now()}`;

  const location = node.locationId ? await prisma.location.findUnique({ where: { id: node.locationId } }) : null;
  const vertical = node.verticalId ? await prisma.vertical.findUnique({ where: { id: node.verticalId } }) : null;
  const sitePages = await prisma.sitePage.findMany({
    where: { companyId: company.id, contentType: { in: ["service", "industry", "location"] } },
    select: { path: true, primaryTopic: true }, take: 25,
  });
  const evidence = (node.evidence ?? {}) as any;
  const profile = (company.profile ?? {}) as any;
  const vProfile = (vertical?.profile ?? {}) as any;

  const competitors = await prisma.competitor.findMany({
    where: { companyId: company.id }, select: { domain: true },
  });
  const topicCompetitors: string[] = [
    ...new Set([...(evidence.competitorDomains ?? []), ...(evidence.listedCompetitorsPresent ?? [])]),
  ];
  const competitorBlock = competitors.length
    ? `COMPETITORS: ${competitors.map((c) => c.domain).join(", ")}. ${topicCompetitors.length ? `For THIS question, these already have content: ${topicCompetitors.join(", ")}. ` : ""}Your article must be more complete, more specific, and better structured for AI extraction than theirs — do NOT name or link them.`
    : "";

  const pricing = await prisma.pricingRange.findMany({ where: { companyId: company.id }, orderBy: { service: "asc" } });
  const pricingBlock = pricing.length
    ? `OFFICIAL PRICING RANGES (the ONLY allowed source for company pricing — always present as ranges, exactly these numbers, never narrowed to a single figure, never extended):
${pricing.map((r) => `- ${r.service}: $${r.low}–$${r.high} ${r.unit}${r.notes ? ` (${r.notes})` : ""}`).join("\n")}`
    : "";

  const testimonials = await relevantTestimonials(company.id, {
    question: node.question, category: node.category, verticalName: vertical?.name, take: 5,
  });
  const testimonialBlock = testimonials.length
    ? `REAL CLIENT TESTIMONIALS & EXAMPLES (from the company's own client testimonials / Google reviews — quote or paraphrase ACCURATELY, use for the real-example section and social proof; these are DIFFERENT clients — pick the ONE that best fits this article's topic and location, don't default to the first; anonymize client names to first name + industry if the full name feels sensitive; only claim a client's city if it is given below; NEVER alter numbers):
${testimonials.map((t, i) => `[${i + 1}] ${t.clientName ?? "Client"}${t.industry ? ` (${t.industry})` : ""}${t.location ? `, ${t.location}` : ""}: "${t.quote.slice(0, 500)}"${t.resultClaim ? ` — Result: ${t.resultClaim}` : ""}${(t.metrics as string[]).length ? ` — Metrics: ${(t.metrics as string[]).join("; ")}` : ""}`).join("\n")}`
    : "";

  const groundingBlock = `
COMPANY: ${company.name} (${company.url})
PROFILE: ${JSON.stringify(profile).slice(0, 2500)}
${vertical ? `VERTICAL: ${vertical.name}\nVERTICAL PROFILE: ${JSON.stringify(vProfile).slice(0, 2000)}` : ""}
${location ? `LOCATION: ${location.city}, ${location.state ?? ""}, ${countryName(location.country)} — use ${countryName(location.country)} regulations, terminology and currency, never another country's` : ""}
${pricingBlock}
${competitorBlock}
${testimonialBlock}
LIVE EVIDENCE (from gap analysis): ${JSON.stringify({ peopleAlsoAsk: evidence.peopleAlsoAsk, competitorsCited: evidence.competitorsCited, hasAiOverview: evidence.hasAiOverview }).slice(0, 1200)}
EXISTING SITE PAGES (for internal links — use these exact paths): ${sitePages.map((p) => p.path).join(", ")}`;

  const contract = `CONTENT CONTRACT (every rule is mandatory):
- The article answers: "${node.question}"
- bodyHtml contains NO <h1> (the CMS renders the title as h1). Use <h2>/<h3>, <p>, <ul>/<ol>, <table> with real <thead>/<tbody>.
- FIRST element is the answer block: one <p> of 40-60 words that directly, self-containedly answers the question and contains at least one concrete number.
- 4-6 question-shaped <h2> sections (each answers a sub-question a buyer would ask an AI). Atomic paragraphs of 2-4 lines, one idea each.
- Include one isolated bolded data line (<p><strong>...</strong></p>) with a key figure.
- Include a comparison <table> ONLY if the topic is genuinely comparative; otherwise a numbered or bulleted list where procedural.
- End key sections with a short declarative takeaway sentence.
- A "Frequently asked questions" <h2> section at the end with each FAQ as <h3>question</h3><p>40-60 word answer</p> — these must exactly match the faqs array.
- 2-4 internal links (<a href="/...">) using ONLY the provided existing site paths, with descriptive anchor text.
- GROUNDING RULES: company pricing may ONLY come from OFFICIAL PRICING RANGES when provided (always as the full range); other company-specific claims (SLAs, certifications, guarantees, years, team size) may ONLY come from the PROFILE. If a specific number would strengthen the article but is unknown, write [OWNER: describe what's needed] instead of inventing it. General industry facts are fine but must be conservative and verifiable; NO invented statistics.
- Voice: ${profile.brandVoice ?? "plain, confident, no jargon"}. No fluff phrases ("in today's fast-paced world", "it's important to note", "in conclusion"), no hedging filler, varied sentence length.
- 1300-2000 words. Word count is an output of substance, not a target to pad.
- If a location is given, localize genuinely (local market/regulatory specifics), never just city-name insertion.
${testimonials.length ? `- MANDATORY: weave in at least one (max two) of the provided REAL CLIENT TESTIMONIALS as a real-world example — either a short quoted excerpt with attribution (first name + industry, e.g. 'Sarah, a Salt Lake City dental practice') inside the most relevant section, or an accurately retold example paragraph. Keep quotes verbatim; never alter their facts or numbers.` : ""}`;

  await step("drafting");
  const draft = await chatJson<DraftJson>([
    { role: "system", content: "You are a senior content writer for AI-search (AEO) + SEO. You write genuinely useful, information-dense articles that AI engines can lift as citations. Reply with JSON only." },
    { role: "user", content: `${contract}\n\n${groundingBlock}\n\nReturn JSON: {"title":"the buyer's question, natural phrasing","metaTitle":"<=60 chars","metaDescription":"70-155 chars","slug":"kebab-case","bodyHtml":"...","faqs":[{"q":"...","a":"40-60 words"}],"internalLinks":["/path", ...]}` },
  ], { companyId: company.id, tag: "generate-draft", maxTokens: 16000, temperature: 0.6, blogPostId: refreshPost?.id, runRef: costRef });

  // Self-critique pass: tighten against the contract before the code gates run
  await step("self-critique");
  const critiqued = await chatJson<DraftJson>([
    { role: "system", content: "You are a ruthless editor enforcing an AEO content contract. Fix violations, strip fluff/hedging, verify the answer block is self-contained with a number, ensure FAQ h3s exactly match the faqs array, keep all grounding rules. Return the corrected article as JSON in the same shape. Reply JSON only." },
    { role: "user", content: `${contract}\n\nARTICLE JSON:\n${JSON.stringify(draft)}` },
  ], { companyId: company.id, tag: "generate-critique", maxTokens: 16000, temperature: 0.2, blogPostId: refreshPost?.id, runRef: costRef });

  const usedTestimonialIds = (bodyHtml: string): string[] => {
    const body = bodyHtml.replace(/<[^>]+>/g, " ").toLowerCase();
    return testimonials.filter((t) => {
      const name = (t.clientName ?? "").split(" ")[0]?.toLowerCase();
      const frag = t.quote.toLowerCase().replace(/\s+/g, " ").slice(10, 48);
      return (name && name.length > 2 && body.includes(name)) || (frag.length > 20 && body.includes(frag));
    }).map((t) => t.id);
  };
  const testimonialUsed = (bodyHtml: string): boolean =>
    !testimonials.length || usedTestimonialIds(bodyHtml).length > 0;
  const runGates = (art: DraftJson, ld: unknown) => {
    const qaRes = runQaGates({ ...art, jsonLd: ld });
    const used = testimonialUsed(art.bodyHtml);
    qaRes.gates.push({ name: "real_example_used", ok: used, required: testimonials.length > 0, detail: used ? undefined : "none of the provided client testimonials appear in the article" });
    qaRes.pass = qaRes.gates.every((x) => x.ok || !x.required);
    return qaRes;
  };
  await step("qa-gates");
  let article = critiqued;
  let jsonLd = buildJsonLd(article, company, location, profile);
  let qa = runGates(article, jsonLd);

  // Repair loop: failed required gates get a targeted fix pass (max 2)
  for (let attempt = 0; !qa.pass && attempt < 2; attempt++) {
    await step(`repair-${attempt + 1}`);
    const failures = qa.gates.filter((x) => !x.ok && x.required)
      .map((x) => `- ${x.name}${x.detail ? ` (${x.detail})` : ""}`).join("\n");
    article = await chatJson<DraftJson>([
      { role: "system", content: "You fix specific contract violations in an article without rewriting what already works. Return the full corrected article JSON in the same shape. Reply JSON only." },
      { role: "user", content: `${contract}\n\nFAILED CHECKS TO FIX:\n${failures}\n\nARTICLE JSON:\n${JSON.stringify(article)}` },
    ], { companyId: company.id, tag: "generate-repair", maxTokens: 16000, temperature: 0.2, blogPostId: refreshPost?.id, runRef: costRef });
    jsonLd = buildJsonLd(article, company, location, profile);
    qa = runGates(article, jsonLd);
  }
  const critiquedFinal = article;

  await step("saving");
  const testimonialIds = usedTestimonialIds(critiquedFinal.bodyHtml);
  await markTestimonialsUsed(testimonialIds);
  if (refreshPost) {
    // rewrite-in-place: keep the slug (and CMS page identity); back to review
    const prevPublish = ((refreshPost.qa as any) ?? {}).publish;
    const post = await prisma.blogPost.update({
      where: { id: refreshPost.id },
      data: {
        title: critiquedFinal.title,
        status: "review",
        bodyHtml: critiquedFinal.bodyHtml,
        publishError: null,
        seo: {
          metaTitle: critiquedFinal.metaTitle,
          metaDescription: critiquedFinal.metaDescription,
          faqs: critiquedFinal.faqs as any,
          jsonLd: jsonLd as any,
          internalLinks: critiquedFinal.internalLinks,
          targetQuestion: node.question,
          testimonialIds,
        },
        qa: { ...(qa as any), rewriteOf: refreshPost.publishedUrl ?? null, publish: prevPublish } as any,
      },
    });
    console.log(`[generate-blog] REWROTE "${critiquedFinal.title}" qa=${qa.pass ? "PASS" : "FAIL"}`);
    return { status: "ok", blogPostId: post.id, qaPass: qa.pass, rewrite: true };
  }
  // race guard: if a concurrent job generated this node meanwhile, discard
  const fresh = await prisma.topicNode.findUniqueOrThrow({ where: { id: node.id }, select: { blogPostId: true } });
  if (fresh.blogPostId) return { status: "already_generated", blogPostId: fresh.blogPostId };
  const post = await prisma.blogPost.create({
    data: {
      companyId: company.id,
      locationId: node.locationId,
      verticalId: node.verticalId,
      topicNodeId: node.id,
      title: critiquedFinal.title,
      slug: critiquedFinal.slug,
      status: "draft",
      bodyHtml: critiquedFinal.bodyHtml,
      contentMd: "",
      seo: {
        metaTitle: critiquedFinal.metaTitle,
        metaDescription: critiquedFinal.metaDescription,
        faqs: critiquedFinal.faqs as any,
        jsonLd: jsonLd as any,
        internalLinks: critiquedFinal.internalLinks,
        targetQuestion: node.question,
        testimonialIds,
      },
      qa: qa as any,
    },
  });
  await prisma.topicNode.update({ where: { id: node.id }, data: { blogPostId: post.id } });
  await prisma.$executeRaw`UPDATE "DataFetchLog" SET "blogPostId" = ${post.id} WHERE "blogPostId" IS NULL AND meta->>'runRef' = ${costRef}`.catch(() => null);

  console.log(`[generate-blog] "${critiquedFinal.title}" qa=${qa.pass ? "PASS" : "FAIL"} (${qa.gates.filter((x) => !x.ok).map((x) => x.name).join(",") || "all green"})`);
  return { status: "ok", blogPostId: post.id, qaPass: qa.pass };
}

function buildJsonLd(d: DraftJson, company: { name: string; url: string }, location: { city: string; state: string | null; country: string } | null, profile: any) {
  const origin = new URL(company.url).origin;
  const graph: any[] = [
    {
      "@type": "BlogPosting",
      headline: d.title,
      description: d.metaDescription,
      datePublished: new Date().toISOString().slice(0, 10),
      dateModified: new Date().toISOString().slice(0, 10),
      author: { "@type": "Organization", name: company.name, url: origin },
      publisher: { "@type": "Organization", name: company.name, url: origin },
      // best-effort until publish; the publisher rewrites this to the real
      // permalink the CMS returns (structures vary: /blog/, /YYYY/MM/DD/, bare)
      url: `${origin}/${d.slug}`,
      mainEntityOfPage: { "@type": "WebPage", "@id": `${origin}/${d.slug}` },
    },
    {
      "@type": "FAQPage",
      mainEntity: d.faqs.map((f) => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];
  if (location) {
    graph.push({
      "@type": "LocalBusiness",
      name: company.name,
      url: origin,
      address: { "@type": "PostalAddress", addressLocality: location.city, addressRegion: location.state ?? undefined, addressCountry: location.country },
      areaServed: [location.city],
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}
