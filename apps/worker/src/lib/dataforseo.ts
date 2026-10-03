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
  organicRanked: { domain: string; rank: number; url: string }[];
  localPack: { domain: string; rank: number; title: string }[];
}

/** Where Google is searched from: a DataForSEO location_code or location_name. */
export type SerpWhere = { code: number } | { name: string };

const PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const COUNTRY_NAMES: Record<string, string> = { CA: "Canada", US: "United States", GB: "United Kingdom", AU: "Australia" };

/**
 * Resolve the city-level DataForSEO location for a tenant Location (names
 * are irregular, e.g. "Nanaimo,Nanaimo,British Columbia,Canada", so we match
 * against their location list). Stored on Location.serpLocationCode; falls
 * back to the country when the city isn't in their list.
 */
export async function serpLocationFor(loc: { id: string; city: string; state: string | null; country: string; serpLocationCode?: number | null }): Promise<SerpWhere> {
  const country = COUNTRY_NAMES[loc.country] ?? "United States";
  if (loc.serpLocationCode) return { code: loc.serpLocationCode };
  try {
    const res = await fetch(`${BASE}/serp/google/locations/${loc.country.toLowerCase()}`, { headers: { Authorization: authHeader() } });
    const rows: any[] = ((await res.json()) as any)?.tasks?.[0]?.result ?? [];
    const region = (loc.country === "CA" ? PROVINCES : US_STATES)[loc.state ?? ""] ?? loc.state ?? "";
    const city = loc.city.toLowerCase();
    const hit = rows.find((r) => {
      const parts = String(r.location_name).split(",");
      return r.location_type === "City" && parts[0]!.toLowerCase() === city
        && (!region || parts.includes(region)) && parts[parts.length - 1] === country;
    });
    if (hit) {
      await prisma.location.update({ where: { id: loc.id }, data: { serpLocationCode: hit.location_code } });
      return { code: hit.location_code };
    }
  } catch (e: any) {
    console.warn(`[dataforseo] location lookup failed for ${loc.city}: ${e?.message}`);
  }
  return { name: country };
}

export function countrySerpLocation(country: string | null | undefined): SerpWhere {
  return { name: COUNTRY_NAMES[country ?? "US"] ?? "United States" };
}

/**
 * LIVE Google SERP probe (organic + AI Overview + People Also Ask).
 * This is the "live results, never cache" primitive — every call hits Google
 * through DataForSEO at request time and is stamped liveFetchedAt.
 */
export async function serpProbe(
  keyword: string, tenantHost: string, companyId: string,
  where: SerpWhere = { name: "United States" },
): Promise<SerpProbe> {
  const results = await post<any>("/serp/google/organic/live/advanced", [{
    keyword, ...("code" in where ? { location_code: where.code } : { location_name: where.name }), language_code: "en",
    device: "desktop", depth: 20, load_async_ai_overview: true, people_also_ask_click_depth: 1,
  }], companyId);
  // a failed task must not read as "nobody ranks" — that would fabricate a gap
  if (!results[0]) throw new Error(`no SERP result for "${keyword}"`);
  const r = results[0];
  const norm = (d: string) => (d ?? "").replace(/^www\./, "");
  const tenant = norm(tenantHost);
  const organicDomains: string[] = [];
  const aiOverviewDomains: string[] = [];
  const peopleAlsoAsk: string[] = [];
  const organicRanked: SerpProbe["organicRanked"] = [];
  const localPack: SerpProbe["localPack"] = [];
  let hasAiOverview = false;
  for (const item of r.items ?? []) {
    if (item.type === "organic" && item.domain && organicDomains.length < 10) organicDomains.push(norm(item.domain));
    if (item.type === "organic" && item.domain) {
      organicRanked.push({ domain: norm(item.domain), rank: item.rank_group ?? organicRanked.length + 1, url: item.url ?? "" });
    }
    if (item.type === "local_pack") {
      localPack.push({ domain: item.domain ? norm(item.domain) : "", rank: localPack.length + 1, title: item.title ?? "" });
    }
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
    organicRanked,
    localPack,
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
