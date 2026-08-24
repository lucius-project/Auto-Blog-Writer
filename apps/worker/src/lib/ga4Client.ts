import { JWT } from "google-auth-library";
import { prisma } from "./prisma.js";

const BASE = "https://analyticsdata.googleapis.com/v1beta";

async function accessToken(serviceAccountJson: string): Promise<string> {
  const creds = JSON.parse(serviceAccountJson);
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  const token = await client.authorize();
  if (!token.access_token) throw new Error("ga4: failed to mint access token");
  return token.access_token;
}

async function runReport(propertyId: string, token: string, body: unknown, companyId: string): Promise<any> {
  const res = await fetch(`${BASE}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ga4 runReport ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  await prisma.dataFetchLog.create({
    data: { companyId, provider: "ga4", endpoint: "runReport", meta: { rowCount: data.rowCount ?? 0 } },
  });
  return data;
}

function toDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export interface AnalyticsTrendPoint { date: string; users: number; sessions: number }
export interface AnalyticsTopPage { path: string; users: number; sessions: number }
export interface AnalyticsSummary {
  totalUsers: number;
  totalSessions: number;
  trend: AnalyticsTrendPoint[];
  topPagesRaw: AnalyticsTopPage[];
  liveFetchedAt: string;
}

/**
 * LIVE GA4 rolling-window report: site-wide daily trend + per-page leaderboard.
 * Every call hits the GA4 Data API at request time and is stamped liveFetchedAt
 * — no caching layer, matching the DataForSEO live-fetch convention.
 */
export async function fetchAnalyticsSummary(
  propertyId: string,
  serviceAccountJson: string,
  companyId: string,
  days = 30,
): Promise<AnalyticsSummary> {
  const token = await accessToken(serviceAccountJson);
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];

  const trendData = await runReport(propertyId, token, {
    dateRanges,
    dimensions: [{ name: "date" }],
    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  }, companyId);
  const trend: AnalyticsTrendPoint[] = (trendData.rows ?? []).map((r: any) => ({
    date: toDate(r.dimensionValues[0].value),
    users: Number(r.metricValues[0].value) || 0,
    sessions: Number(r.metricValues[1].value) || 0,
  }));
  const totalUsers = trend.reduce((sum, p) => sum + p.users, 0);
  const totalSessions = trend.reduce((sum, p) => sum + p.sessions, 0);

  const pagesData = await runReport(propertyId, token, {
    dateRanges,
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 50,
  }, companyId);
  const topPagesRaw: AnalyticsTopPage[] = (pagesData.rows ?? []).map((r: any) => ({
    path: r.dimensionValues[0].value,
    users: Number(r.metricValues[0].value) || 0,
    sessions: Number(r.metricValues[1].value) || 0,
  }));

  return { totalUsers, totalSessions, trend, topPagesRaw, liveFetchedAt: new Date().toISOString() };
}
