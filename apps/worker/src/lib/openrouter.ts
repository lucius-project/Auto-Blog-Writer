import { prisma } from "./prisma.js";

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5";

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
      "HTTP-Referer": "https://github.com/911it/Auto-Blog-Writer",
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
    throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
