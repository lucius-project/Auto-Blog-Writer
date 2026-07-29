import { prisma } from "./prisma.js";

const BASE = "https://api.dataforseo.com/v3";

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN ?? "";
  const password = process.env.DATAFORSEO_PASSWORD ?? "";
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function post<T>(path: string, tasks: unknown[], companyId?: string): Promise<T[]> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(tasks),
  });
  if (!res.ok) throw new Error(`dataforseo ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  if (data.status_code !== 20000) throw new Error(`dataforseo ${path}: ${data.status_message}`);
  await prisma.dataFetchLog.create({
    data: {
      companyId, provider: "dataforseo", endpoint: path,
      cost: data.cost ?? null,
      meta: { tasksCount: data.tasks_count, tasksError: data.tasks_error },
    },
  });
  const out: T[] = [];
  for (const t of data.tasks ?? []) {
    if (t.status_code !== 20000) { console.warn(`[dataforseo] task error: ${t.status_message}`); continue; }
    for (const r of t.result ?? []) out.push(r as T);
  }
  return out;
}

export interface SerpProbe {
  keyword: string;
  liveFetchedAt: string;
  tenantInOrganicTop10: boolean;
  tenantInAiOverview: boolean;
  hasAiOverview: boolean;
  organicDomains: string[];
  aiOverviewDomains: string[];
  peopleAlsoAsk: string[];
}

/**
 * LIVE Google SERP probe (organic + AI Overview + People Also Ask).
 * This is the "live results, never cache" primitive — every call hits Google
 * through DataForSEO at request time and is stamped liveFetchedAt.
 */
export async function serpProbe(
  keyword: string, tenantHost: string, companyId: string,
  locationName = "United States",
): Promise<SerpProbe> {
  const results = await post<any>("/serp/google/organic/live/advanced", [{
    keyword, location_name: locationName, language_code: "en",
    device: "desktop", depth: 20, load_async_ai_overview: true, people_also_ask_click_depth: 1,
  }], companyId);
  const r = results[0] ?? {};
  const norm = (d: string) => (d ?? "").replace(/^www\./, "");
  const tenant = norm(tenantHost);
  const organicDomains: string[] = [];
  const aiOverviewDomains: string[] = [];
  const peopleAlsoAsk: string[] = [];
  let hasAiOverview = false;
  for (const item of r.items ?? []) {
    if (item.type === "organic" && item.domain && organicDomains.length < 10) organicDomains.push(norm(item.domain));
    if (item.type === "people_also_ask") {
      for (const paa of item.items ?? []) if (paa.title) peopleAlsoAsk.push(String(paa.title));
    }
    if (item.type === "ai_overview") {
      hasAiOverview = true;
      for (const ref of item.references ?? []) if (ref.domain) aiOverviewDomains.push(norm(ref.domain));
      for (const sub of item.items ?? []) for (const ref of sub.references ?? []) if (ref.domain) aiOverviewDomains.push(norm(ref.domain));
    }
  }
  return {
    keyword,
    liveFetchedAt: new Date().toISOString(),
    tenantInOrganicTop10: organicDomains.includes(tenant),
    tenantInAiOverview: aiOverviewDomains.includes(tenant),
    hasAiOverview,
    organicDomains,
    aiOverviewDomains: [...new Set(aiOverviewDomains)],
    peopleAlsoAsk: [...new Set(peopleAlsoAsk)].slice(0, 10),
  };
}

/** Monthly search volumes for up to 1000 keywords (Google Ads data). */
export async function searchVolumes(
  keywords: string[], companyId: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!keywords.length) return map;
  const results = await post<any>("/keywords_data/google_ads/search_volume/live", [{
    keywords: keywords.slice(0, 700), location_name: "United States", language_code: "en",
  }], companyId);
  for (const r of results) {
    // result is a list itself for this endpoint
    const rows = Array.isArray(r) ? r : [r];
    for (const row of rows) if (row?.keyword) map.set(String(row.keyword).toLowerCase(), row.search_volume ?? 0);
  }
  return map;
}

export async function accountBalance(): Promise<number | null> {
  try {
    const res = await fetch(BASE + "/appendix/user_data", { headers: { Authorization: authHeader() } });
    const data = (await res.json()) as any;
    return data?.tasks?.[0]?.result?.[0]?.money?.balance ?? null;
  } catch { return null; }
}
