/**
 * Competitive benchmark scoring — pure functions shared by the worker (run
 * summaries for trends) and the API (full scorecard + breakdowns).
 *
 * Visibility score (0-100) = mean over queries of
 *   0.50 x Google organic weight (position-weighted, #1 = 1.0 ... #10 = 0.17, 11-20 = 0.05)
 * + 0.25 x map/local-pack weight (#1 = 1.0, #2 = 0.75, #3 = 0.6)
 * + 0.25 x cited in the Google AI Overview
 */

/**
 * A "running" BenchmarkRun whose heartbeat (updatedAt, bumped on every probe)
 * is older than this was interrupted (worker restart/crash), not in progress.
 */
export const BENCHMARK_STALE_MS = 10 * 60 * 1000;
export const isBenchmarkRunLive = (r: { status: string; updatedAt: Date }) =>
  r.status === "running" && Date.now() - r.updatedAt.getTime() < BENCHMARK_STALE_MS;

export interface BenchmarkRow {
  queryId: string;
  query: string;
  intent: string;
  locationId: string;
  verticalId: string | null;
  organic: { domain: string; rank: number; url?: string }[];
  localPack: { domain: string; rank: number; title?: string }[];
  aiOverview: string[];
  hasAiOverview: boolean;
}

export interface DomainScore {
  domain: string;
  queries: number;
  score: number;
  top3: number;
  top10: number;
  top3Rate: number;
  top10Rate: number;
  avgRank: number | null;
  localPack: number;
  localPackRate: number;
  ai: number;
  aiRate: number; // of queries that showed an AI Overview
  aiEligible: number;
  winsVsTenant: number; // queries where this domain out-scores the tenant
}

const ORGANIC_W = [1, 0.7, 0.55, 0.45, 0.38, 0.32, 0.27, 0.23, 0.2, 0.17];
const PACK_W = [1, 0.75, 0.6];

export const normDomain = (d: string) => (d ?? "").toLowerCase().replace(/^www\./, "");
const matches = (seen: string, domain: string) => seen === domain || seen.endsWith(`.${domain}`);

export interface QueryHit { rank: number | null; packRank: number | null; ai: boolean; points: number }

export function queryHit(row: BenchmarkRow, domain: string): QueryHit {
  const d = normDomain(domain);
  const rank = row.organic.filter((o) => matches(normDomain(o.domain), d)).map((o) => o.rank).sort((a, b) => a - b)[0] ?? null;
  const packRank = row.localPack.filter((o) => matches(normDomain(o.domain), d)).map((o) => o.rank).sort((a, b) => a - b)[0] ?? null;
  const ai = row.aiOverview.some((a) => matches(normDomain(a), d));
  const orgW = rank == null ? 0 : rank <= 10 ? ORGANIC_W[rank - 1]! : rank <= 20 ? 0.05 : 0;
  const packW = packRank == null ? 0 : PACK_W[packRank - 1] ?? 0.4;
  return { rank, packRank, ai, points: 0.5 * orgW + 0.25 * packW + 0.25 * (ai ? 1 : 0) };
}

export function scoreDomain(rows: BenchmarkRow[], domain: string, tenant?: string): DomainScore {
  let top3 = 0, top10 = 0, pack = 0, ai = 0, aiEligible = 0, points = 0, wins = 0;
  const ranks: number[] = [];
  for (const r of rows) {
    const h = queryHit(r, domain);
    points += h.points;
    if (h.rank != null) { ranks.push(h.rank); if (h.rank <= 3) top3++; if (h.rank <= 10) top10++; }
    if (h.packRank != null) pack++;
    if (r.hasAiOverview) { aiEligible++; if (h.ai) ai++; }
    if (tenant && normDomain(domain) !== normDomain(tenant) && h.points > queryHit(r, tenant).points) wins++;
  }
  const n = rows.length;
  const pct = (v: number, of = n) => (of ? Math.round((v / of) * 100) : 0);
  return {
    domain: normDomain(domain), queries: n,
    score: n ? Math.round((points / n) * 1000) / 10 : 0,
    top3, top10, top3Rate: pct(top3), top10Rate: pct(top10),
    avgRank: ranks.length ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10 : null,
    localPack: pack, localPackRate: pct(pack),
    ai, aiEligible, aiRate: pct(ai, aiEligible),
    winsVsTenant: wins,
  };
}

// Big platforms/directories that show up everywhere — reported separately
// from real competitors so they don't crowd the "untracked" list.
const PLATFORMS = /(^|\.)(reddit|facebook|linkedin|youtube|instagram|quora|yelp|google|wikipedia|indeed|glassdoor|clutch|goodfirms|designrush|upcity|cloudtango|yellowpages|canada411|bbb|tiktok|x|twitter|amazon|microsoft|apple|cbc|globalnews|ctvnews|gov|canada)\.[a-z.]+$/;
export const isPlatform = (d: string) => PLATFORMS.test(normDomain(d)) || /\.gov(\.|$)|\.gc\.ca$|\.edu$/.test(normDomain(d));

/** Domains that out-appear in the results but aren't tracked yet. */
export function untrackedDomains(rows: BenchmarkRow[], tracked: string[], limit = 12) {
  const known = new Set(tracked.map(normDomain));
  const all = new Set<string>();
  for (const r of rows) {
    for (const o of r.organic) if (o.rank <= 10) all.add(normDomain(o.domain));
    for (const o of r.localPack) all.add(normDomain(o.domain));
    for (const a of r.aiOverview) all.add(normDomain(a));
  }
  return [...all]
    .filter((d) => d && ![...known].some((k) => matches(d, k)))
    .map((d) => ({ ...scoreDomain(rows, d), platform: isPlatform(d) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Map a stored BenchmarkResult row (JSON columns) to a scoring row. */
export function toBenchmarkRow(r: {
  queryId: string; query: string; intent: string; locationId: string; verticalId: string | null;
  organic: unknown; localPack: unknown; aiOverview: unknown; hasAiOverview: boolean;
}): BenchmarkRow {
  return {
    queryId: r.queryId, query: r.query, intent: r.intent, locationId: r.locationId, verticalId: r.verticalId,
    organic: (r.organic ?? []) as BenchmarkRow["organic"],
    localPack: (r.localPack ?? []) as BenchmarkRow["localPack"],
    aiOverview: (r.aiOverview ?? []) as string[],
    hasAiOverview: r.hasAiOverview,
  };
}
