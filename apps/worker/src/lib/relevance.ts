import { chatJson } from "./openrouter.js";

/**
 * Keep only questions a buyer of this company's services would plausibly ask
 * on the way to hiring them. Google "People also ask" and competitor crawls
 * drift fast ("Victoria" -> Queen Victoria, IT -> IT salaries); anything that
 * isn't a customer's question wastes live probes and writing budget.
 */
export async function relevantQuestions(
  companyId: string, context: string, questions: string[],
): Promise<Set<string>> {
  const keep = new Set<string>();
  const uniq = [...new Set(questions.filter(Boolean))];
  const BATCH = 60;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const res = await chatJson<{ keep: number[] }>([
      { role: "system", content: "You filter search questions for a B2B IT services company's content plan. KEEP a question only if a business owner/manager who might hire this company would ask it while dealing with a business technology problem, choosing or evaluating an IT/cybersecurity provider, or meeting an IT-related compliance duty. DROP history, trivia, celebrities, personal finance, consumer tech, IT careers/salaries/jobs, travel, currency, immigration, and anything a place name was merely mistaken for. Reply JSON only." },
      { role: "user", content: `COMPANY CONTEXT: ${context}\n\nQUESTIONS:\n${batch.map((q, j) => `${j}: ${q}`).join("\n")}\n\nReturn {"keep":[indexes to keep]}` },
    ], { companyId, tag: "relevance-filter", maxTokens: 1500, temperature: 0 });
    for (const j of res.keep ?? []) if (batch[j]) keep.add(batch[j]!);
  }
  return keep;
}
