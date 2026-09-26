import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const RENEW_URL = "https://openrouter.ai/settings/credits";
/** warn below this many USD of remaining OpenRouter credit */
const WARN_USD = Number(process.env.AI_CREDIT_WARN_USD ?? 10);
/** treat as out of credit below this (a single article run costs more) */
const EXHAUSTED_USD = 1;

type CreditStatus = {
  status: "ok" | "low" | "exhausted" | "unknown";
  remaining: number | null;
  total: number | null;
  warnBelow: number;
  lastCreditErrorAt: string | null;
  renewUrl: string;
  checkedAt: string;
};

let cache: { at: number; value: CreditStatus } | null = null;

/** Platform-wide AI (OpenRouter) credit balance — drives the "renew credits" popup. */
export async function systemRoutes(app: FastifyInstance) {
  app.get("/system/ai-credits", async () => {
    if (cache && Date.now() - cache.at < 60_000) return cache.value;

    // a worker call bounced with 402 recently (logged as a notification)
    const lastErr = await prisma.notification.findFirst({
      where: { type: "credits_exhausted", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
    });

    let remaining: number | null = null, total: number | null = null;
    try {
      const res = await fetch(`${OPENROUTER_BASE}/credits`, {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const d = ((await res.json()) as any)?.data ?? {};
        total = Number(d.total_credits);
        remaining = total - Number(d.total_usage);
      } else {
        app.log.warn(`openrouter credits ${res.status}`);
      }
    } catch (e: any) {
      app.log.warn(`openrouter credits check failed: ${e?.message}`);
    }

    let status: CreditStatus["status"] = "unknown";
    if (remaining !== null && Number.isFinite(remaining)) {
      if (remaining < EXHAUSTED_USD || (lastErr && remaining < WARN_USD)) status = "exhausted";
      else if (remaining < WARN_USD) status = "low";
      else status = "ok";
    } else if (lastErr) {
      status = "exhausted";
    }

    const value: CreditStatus = {
      status,
      remaining: remaining !== null && Number.isFinite(remaining) ? Math.round(remaining * 100) / 100 : null,
      total: total !== null && Number.isFinite(total) ? total : null,
      warnBelow: WARN_USD,
      lastCreditErrorAt: lastErr?.createdAt.toISOString() ?? null,
      renewUrl: RENEW_URL,
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    return value;
  });
}
