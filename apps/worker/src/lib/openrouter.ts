import { prisma } from "./prisma.js";
import { notify } from "./notify.js";

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5";

/**
 * OpenRouter answers 402 when the account is out of credit. Surface it as a
 * notification (at most one per 6h) — the web app's credits popup keys off it
 * alongside the live balance.
 */
export async function reportCreditError(status: number, detail: string) {
  if (status !== 402) return;
  try {
    const recent = await prisma.notification.findFirst({
      where: { type: "credits_exhausted", createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
    });
    if (recent) return;
    await notify({
      type: "credits_exhausted",
      title: "OpenRouter credits exhausted — AI work is failing",
      body: `Writing, research and images can't run until credits are added. ${detail.slice(0, 120)}`,
      href: "https://openrouter.ai/settings/credits",
    });
  } catch (e) {
    console.warn(`[openrouter] credit alert failed: ${(e as Error).message}`);
  }
}

export interface ChatOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** parse the response as JSON (asks for json_object output) */
  json?: boolean;
  companyId?: string;
  tag?: string;
  /** attribute this call's cost to a specific blog post */
  blogPostId?: string;
  /** correlation ref for attributing later (post not created yet) — stored in meta.runRef */
  runRef?: string;
}

export async function chat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: ChatOpts = {},
): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/lucius-project/Auto-Blog-Writer",
      "X-Title": "Automated Blog Writer",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature ?? 0.4,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    await reportCreditError(res.status, detail);
    throw new Error(`openrouter ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  await prisma.dataFetchLog.create({
    data: {
      companyId: opts.companyId,
      blogPostId: opts.blogPostId,
      provider: "openrouter",
      endpoint: opts.tag ?? "chat",
      cost: data.usage?.cost ?? null,
      meta: { model, usage: data.usage ?? null, ...(opts.runRef ? { runRef: opts.runRef } : {}) },
    },
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("openrouter: empty completion");
  return content;
}

/** chat() that must return valid JSON; retries once on parse failure. */
export async function chatJson<T = unknown>(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: ChatOpts = {},
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(messages, { ...opts, json: true });
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      return JSON.parse(cleaned) as T;
    } catch {
      if (attempt === 1) throw new Error(`openrouter: invalid JSON after retry: ${raw.slice(0, 200)}`);
    }
  }
  throw new Error("unreachable");
}
