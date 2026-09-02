import { JWT } from "google-auth-library";
import { prisma } from "./prisma.js";

const BASE = "https://searchconsole.googleapis.com/webmasters/v3";

async function accessToken(serviceAccountJson: string): Promise<string> {
  const creds = JSON.parse(serviceAccountJson);
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const token = await client.authorize();
  if (!token.access_token) throw new Error("gsc: failed to mint access token");
  return token.access_token;
}

/** Every Search Console property this service account has been granted access to. */
export async function listSites(serviceAccountJson: string): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const token = await accessToken(serviceAccountJson);
  const res = await fetch(`${BASE}/sites`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gsc sites.list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
  return data.siteEntry ?? [];
}

interface GscRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }

async function query(
  siteUrl: string, token: string, companyId: string,
  body: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number },
): Promise<GscRow[]> {
  const res = await fetch(`${BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "web", dataState: "final", rowLimit: 25000, ...body }),
  });
  if (!res.ok) throw new Error(`gsc searchAnalytics ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { rows?: GscRow[] };
  await prisma.dataFetchLog.create({
    data: { companyId, provider: "gsc", endpoint: "searchAnalytics", meta: { rows: data.rows?.length ?? 0, dims: body.dimensions ?? [] } },
  });
  return data.rows ?? [];
}

/** GSC lag: data isn't final for ~2 days. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export interface GscQueryRow {
  query: string; clicks: number; impressions: number; ctr: number; position: number;
  prevPosition: number | null; positionDelta: number | null; // + = moved up (better)
}
export interface GscTrendPoint { date: string; clicks: number; impressions: number; position: number }
export interface GscQueryPageRow { query: string; page: string; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchConsoleSummary {
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  prevTotals: { clicks: number; impressions: number; position: number };
  trend: GscTrendPoint[];
  topQueries: GscQueryRow[];
  topPagesRaw: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  queryPages: GscQueryPageRow[];
  liveFetchedAt: string;
}

/**
 * LIVE Search Console report: totals + daily position/click trend (90d) +
 * top queries with their position change vs the previous equal window.
 * Every call hits the API at request time and is stamped liveFetchedAt.
 */
export async function fetchSearchConsoleSummary(
  siteUrl: string, serviceAccountJson: string, companyId: string, days = 28,
): Promise<SearchConsoleSummary> {
  const token = await accessToken(serviceAccountJson);

  const curEnd = daysAgo(2);
  const curStart = daysAgo(2 + days);
  const prevEnd = daysAgo(3 + days);
  const prevStart = daysAgo(3 + days * 2);

  const [curTotalRows, prevTotalRows, trendRows, curQ, prevQ, pageRows, qpRows] = await Promise.all([
    query(siteUrl, token, companyId, { startDate: curStart, endDate: curEnd }),
    query(siteUrl, token, companyId, { startDate: prevStart, endDate: prevEnd }),
    query(siteUrl, token, companyId, { startDate: daysAgo(92), endDate: curEnd, dimensions: ["date"], rowLimit: 100 }),
    query(siteUrl, token, companyId, { startDate: curStart, endDate: curEnd, dimensions: ["query"], rowLimit: 200 }),
    query(siteUrl, token, companyId, { startDate: prevStart, endDate: prevEnd, dimensions: ["query"], rowLimit: 500 }),
    query(siteUrl, token, companyId, { startDate: curStart, endDate: curEnd, dimensions: ["page"], rowLimit: 200 }),
    query(siteUrl, token, companyId, { startDate: curStart, endDate: curEnd, dimensions: ["query", "page"], rowLimit: 500 }),
  ]);

  const t = curTotalRows[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const pt = prevTotalRows[0] ?? { clicks: 0, impressions: 0, position: 0 };
  const prevByQuery = new Map(prevQ.map((r) => [r.keys[0]!, r.position]));

  const topQueries: GscQueryRow[] = curQ
    .map((r) => {
      const q = r.keys[0]!;
      const prev = prevByQuery.get(q) ?? null;
      return {
        query: q, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
        prevPosition: prev, positionDelta: prev != null ? Math.round((prev - r.position) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.impressions - a.impressions);

  return {
    totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: Math.round(t.position * 10) / 10 },
    prevTotals: { clicks: pt.clicks, impressions: pt.impressions, position: Math.round(pt.position * 10) / 10 },
    trend: trendRows
      .map((r) => ({ date: r.keys[0]!, clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topQueries,
    topPagesRaw: pageRows.map((r) => ({ page: r.keys[0]!, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10 })),
    queryPages: qpRows
      .filter((r) => r.impressions >= 5)
      .map((r) => ({ query: r.keys[0]!, page: r.keys[1]!, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10 }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 400),
    liveFetchedAt: new Date().toISOString(),
  };
}
