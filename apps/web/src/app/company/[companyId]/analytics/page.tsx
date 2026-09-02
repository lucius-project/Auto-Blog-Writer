"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type TrendPoint = { date: string; users: number; sessions: number };
type TopPage = { path: string; blogPostId: string; title: string; users: number; sessions: number };
type GscQuery = { query: string; clicks: number; impressions: number; ctr: number; position: number; positionDelta: number | null };
type SearchData = {
  connected: boolean;
  siteUrl?: string;
  serviceAccountEmail?: string | null;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  liveFetchedAt?: string | null;
  totals?: { clicks: number; impressions: number; ctr: number; position: number } | null;
  prevTotals?: { clicks: number; impressions: number; position: number } | null;
  dailyTrend?: { date: string; clicks: number; impressions: number; position: number }[];
  positionHistory?: { at: string; position: number | null; clicks: number | null; impressions: number | null }[];
  topQueries?: GscQuery[];
  improved?: GscQuery[];
  declined?: GscQuery[];
  topPages?: { page: string; blogPostId: string | null; title: string | null; clicks: number; impressions: number; position: number }[];
  opportunities?: {
    ctrFixes: { page: string; path: string; id: string | null; title: string | null; queries: string[]; impressions: number; clicks: number; position: number; missedClicks: number }[];
    strikingDistance: { query: string; position: number; impressions: number; clicks: number; positionDelta: number | null; losing: boolean; path: string; id: string | null; title: string | null }[];
    drops: { query: string; position: number; impressions: number; positionDelta: number | null; path: string; id: string | null; title: string | null }[];
  } | null;
};
type Analytics = {
  connected: boolean;
  propertyId?: string;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  totals?: { totalUsers: number; totalSessions: number } | null;
  trend: TrendPoint[];
  topPages: TopPage[];
  liveFetchedAt?: string | null;
  search?: SearchData;
};

/** Minimal dependency-free SVG line chart (same pattern as the Trends tab). */
function LineChart({ points, label, color = "#2563eb" }: { points: { x: number; y: number }[]; label: string; color?: string }) {
  const W = 640, H = 180, PAD = 34;
  if (points.length < 2) return <div className="flex h-[180px] items-center justify-center text-sm text-gray-400">Not enough data yet — check back after the next sync.</div>;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const top = Math.max(...ys) * 1.15 || 1;
  const sx = (x: number) => PAD + ((x - x0) / (x1 - x0 || 1)) * (W - PAD * 2);
  const sy = (y: number) => H - PAD + -((y / top) * (H - PAD * 2));
  const path = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {gridYs.map((gy, i) => (
        <g key={i}>
          <line x1={PAD} x2={W - PAD} y1={sy(gy)} y2={sy(gy)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD - 6} y={sy(gy) + 4} textAnchor="end" fontSize={10} fill="#9ca3af">{Math.round(gy)}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill={color} />)}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="#9ca3af">{label}</text>
      <text x={PAD} y={12} fontSize={10} fill="#9ca3af">
        {new Date(x0).toLocaleDateString()} — {new Date(x1).toLocaleDateString()}
      </text>
    </svg>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-blue-50" : "bg-gray-50"}`}>
      <div className="text-xl font-semibold">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

type CompVis = {
  tenant: string;
  probed: number;
  lastProbeAt: string | null;
  listedCompetitors: { domain: string; label: string | null }[];
  you: { organic: number; ai: number; organicRate: number; aiRate: number };
  scoreboard: { domain: string; organic: number; ai: number; organicRate: number; aiRate: number; isListed: boolean; label: string | null }[];
  headToHead: {
    topicNodeId: string; question: string; score: number; funnelStage: string; category: string;
    hasBlogPost: boolean; status: string; competitors: string[]; listedCompetitors: string[]; inAiOverview: string[];
  }[];
  trend: { at: string; tenantAiRate: number; topCompetitorAiRate: number; topCompetitorDomain: string | null }[];
};

/** You vs competitors across the buyer questions probed live in the last gap check. */
function CompetitorVisibility({ companyId }: { companyId: string }) {
  const [d, setD] = useState<CompVis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = () => fetch(`${API}/api/companies/${companyId}/competitor-visibility`).then((r) => r.json()).then(setD).catch(() => {});
  useEffect(() => { load(); }, [companyId]);

  const recheck = async () => {
    setBusy("recheck");
    await fetch(`${API}/api/companies/${companyId}/analyze`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ liveProbeCount: 20 }),
    });
    setBusy(null);
    setNote("Live gap check started — pulls fresh SERP/AI-Overview evidence for ~20 questions. Refresh this page in a few minutes.");
  };
  const write = async (topicNodeId: string) => {
    setBusy(topicNodeId);
    await fetch(`${API}/api/jobs/generate-blog`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId, topicNodeId }),
    });
    setBusy(null);
    setNote("Queued — the article will land in the review queue in a couple of minutes.");
  };

  if (!d) return null;

  const rows = [
    { domain: `${d.tenant} (you)`, aiRate: d.you.aiRate, organicRate: d.you.organicRate, isYou: true, isListed: false },
    ...d.scoreboard.map((s) => ({ domain: s.label ? `${s.domain} · ${s.label}` : s.domain, aiRate: s.aiRate, organicRate: s.organicRate, isYou: false, isListed: s.isListed })),
  ].sort((a, b) => b.aiRate - a.aiRate || b.organicRate - a.organicRate);

  const trendPts = { you: d.trend.map((t) => ({ x: new Date(t.at).getTime(), y: t.tenantAiRate })) };

  return (
    <div className="mt-4 rounded-xl border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Search &amp; AI visibility vs competitors</div>
          <p className="mt-1 text-xs text-gray-500">
            {d.probed > 0
              ? <>Measured live on <b>{d.probed}</b> buyer questions during the last gap check
                {d.lastProbeAt && <> · {new Date(d.lastProbeAt).toLocaleDateString()}</>}. “In AI answers” = cited in a Google AI Overview.</>
              : "No live probe evidence yet. Run a gap check to measure where you and your competitors show up."}
          </p>
        </div>
        <button onClick={recheck} disabled={busy === "recheck"}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy === "recheck" ? "Starting…" : "↻ Re-check live"}
        </button>
      </div>
      {note && <p className="mt-2 rounded bg-blue-50 p-2 text-xs text-blue-900">{note}</p>}

      {d.probed > 0 && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label={`You cited in AI answers (${d.you.ai}/${d.probed})`} value={d.you.aiRate} highlight />
            <Stat label={`You in Google top 10 (${d.you.organic}/${d.probed})`} value={d.you.organicRate} />
          </div>

          <div className="mt-5 text-xs font-semibold uppercase tracking-wide text-gray-400">Share of AI answers</div>
          <div className="mt-2 space-y-1.5">
            {rows.map((r) => (
              <div key={r.domain} className="flex items-center gap-2 text-xs">
                <div className={`w-52 shrink-0 truncate ${r.isYou ? "font-bold text-blue-700" : "text-gray-700"}`}>
                  {r.domain}
                  {r.isListed && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">tracked</span>}
                </div>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div className={`h-full rounded-full ${r.isYou ? "bg-blue-600" : r.isListed ? "bg-amber-500" : "bg-gray-400"}`}
                    style={{ width: `${Math.max(r.aiRate, 1)}%` }} />
                </div>
                <div className="w-24 shrink-0 text-right text-gray-500">{r.aiRate}% AI · {r.organicRate}% org</div>
              </div>
            ))}
          </div>

          {d.trend.length >= 2 && (
            <div className="mt-6">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Your AI-answer share over time</div>
              <div className="mt-2"><LineChart points={trendPts.you} label="your AI-answer share %" /></div>
              {(() => {
                const last = d.trend[d.trend.length - 1];
                return last?.topCompetitorDomain ? (
                  <p className="mt-1 text-[11px] text-gray-400">
                    Latest: you {last.tenantAiRate}% · leading competitor {last.topCompetitorDomain} {last.topCompetitorAiRate}%
                  </p>
                ) : null;
              })()}
            </div>
          )}

          {d.headToHead.length > 0 && (
            <div className="mt-6">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Where competitors beat you — {d.headToHead.length} question{d.headToHead.length === 1 ? "" : "s"} a competitor is cited and you aren’t
              </div>
              <table className="mt-2 w-full text-sm">
                <thead><tr className="border-b text-left text-[11px] uppercase text-gray-400">
                  <th className="py-1">Buyer question</th><th>Cited instead of you</th><th></th>
                </tr></thead>
                <tbody>
                  {d.headToHead.map((h) => (
                    <tr key={h.topicNodeId} className="border-b align-top">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{h.question}</div>
                        <div className="text-[11px] text-gray-400">{h.category} · {h.funnelStage}{h.hasBlogPost ? " · article exists" : ""}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {(h.inAiOverview.length ? h.inAiOverview : h.competitors).slice(0, 4).map((c) => (
                            <span key={c} className={`rounded px-1.5 py-0.5 text-[11px] ${h.listedCompetitors.includes(c) ? "bg-amber-100 font-medium text-amber-800" : "bg-gray-100 text-gray-600"}`}>{c}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 text-xs">
                        {h.hasBlogPost
                          ? <a href={`/review/${companyId}`} className="text-blue-600">review →</a>
                          : <button onClick={() => write(h.topicNodeId)} disabled={busy === h.topicNodeId}
                              className="rounded bg-green-600 px-2 py-1 font-medium text-white disabled:opacity-50">
                              {busy === h.topicNodeId ? "…" : "Write it"}
                            </button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-gray-400">
                Amber = a competitor you’re tracking in Settings. Writing an answer-shaped, well-structured article for these is the fastest way to close the gap.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Line chart for average SERP position — y-axis inverted so "up" = better rank. */
function PositionTrend({ points, label }: { points: { x: number; y: number }[]; label: string }) {
  const W = 640, H = 180, PAD = 38;
  const pts = points.filter((p) => p.y != null && p.y > 0);
  if (pts.length < 2) return <div className="flex h-[180px] items-center justify-center text-sm text-gray-400">Not enough history yet — a point is added each sync.</div>;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMin = Math.max(0, Math.floor(Math.min(...ys) - 1));
  const yMax = Math.ceil(Math.max(...ys) + 1);
  const sx = (x: number) => PAD + ((x - x0) / (x1 - x0 || 1)) * (W - PAD * 2);
  // invert: better (lower) position near the top
  const sy = (y: number) => PAD + ((y - yMin) / (yMax - yMin || 1)) * (H - PAD * 2);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const gridYs = [yMin, (yMin + yMax) / 2, yMax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {gridYs.map((gy, i) => (
        <g key={i}>
          <line x1={PAD} x2={W - PAD} y1={sy(gy)} y2={sy(gy)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD - 6} y={sy(gy) + 4} textAnchor="end" fontSize={10} fill="#9ca3af">#{Math.round(gy)}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#16a34a" strokeWidth={2.5} strokeLinejoin="round" />
      {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3} fill="#16a34a" />)}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="#9ca3af">{label} · higher = better rank</text>
    </svg>
  );
}

function RankingOpportunities({ companyId, o }: { companyId: string; o: NonNullable<SearchData["opportunities"]> }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const rewrite = async (postId: string) => {
    await fetch(`${API}/api/posts/${postId}/rewrite`, { method: "POST" });
    setDone((s) => new Set(s).add(postId));
  };
  const PageCell = ({ path, id, title }: { path: string; id: string | null; title: string | null }) => (
    <span>
      <a href={path} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{title ?? path}</a>
      {id && (done.has(id)
        ? <span className="ml-2 text-[11px] text-green-600">rewriting ✓</span>
        : <button onClick={() => rewrite(id)} className="ml-2 rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-medium text-white">Rewrite</button>)}
    </span>
  );
  const nothing = !o.ctrFixes.length && !o.strikingDistance.length && !o.drops.length;
  return (
    <div className="mt-5 rounded-lg border border-indigo-100 bg-indigo-50/40 p-4">
      <div className="text-sm font-semibold">Ranking opportunities</div>
      {nothing && <p className="mt-1 text-xs text-gray-500">Nothing flagged this sync — deltas need a second sync (~a day) to populate.</p>}

      {o.ctrFixes.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Fix titles &amp; meta — you rank, but few clicks</div>
          <p className="text-[11px] text-gray-400">Rewrite the page title + meta description (front-load the query, add a hook). Blog pages have a one-click Rewrite; service pages edit in WordPress.</p>
          <table className="mt-1 w-full text-xs">
            <thead><tr className="border-b text-left text-[10px] uppercase text-gray-400">
              <th className="py-1">Page</th><th>Queries</th><th className="text-right">Pos</th><th className="text-right">Impr.</th><th className="text-right">Missed clicks/mo*</th>
            </tr></thead>
            <tbody>
              {o.ctrFixes.map((f) => (
                <tr key={f.page} className="border-b align-top">
                  <td className="py-1 pr-2"><PageCell path={f.page} id={f.id} title={f.title} /></td>
                  <td className="py-1 pr-2 text-gray-500">{f.queries.join(", ")}</td>
                  <td className="py-1 text-right">#{Math.round(f.position)}</td>
                  <td className="py-1 text-right">{f.impressions.toLocaleString()}</td>
                  <td className="py-1 text-right font-medium text-indigo-700">+{f.missedClicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-400">*rough: expected CTR for that position × impressions − actual clicks, over the 28-day window.</p>
        </div>
      )}

      {o.strikingDistance.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Almost page 1 — strengthen these</div>
          <p className="text-[11px] text-gray-400">Position 8–20. Add a focused section/page for the term, internal links from your strong pages, refresh the content. Red = losing ground.</p>
          <table className="mt-1 w-full text-xs">
            <thead><tr className="border-b text-left text-[10px] uppercase text-gray-400">
              <th className="py-1">Query</th><th className="text-right">Pos</th><th className="text-right">Δ 28d</th><th className="text-right">Impr.</th><th>Ranking page</th>
            </tr></thead>
            <tbody>
              {o.strikingDistance.map((q) => (
                <tr key={q.query} className={`border-b align-top ${q.losing ? "bg-red-50/50" : ""}`}>
                  <td className="py-1 pr-2 font-medium">{q.query}</td>
                  <td className="py-1 text-right">#{Math.round(q.position)}</td>
                  <td className={`py-1 text-right ${q.positionDelta == null ? "text-gray-300" : q.positionDelta > 0 ? "text-green-600" : q.positionDelta < 0 ? "text-red-600" : "text-gray-400"}`}>
                    {q.positionDelta == null ? "—" : q.positionDelta > 0 ? `▲${q.positionDelta}` : q.positionDelta < 0 ? `▼${Math.abs(q.positionDelta)}` : "±0"}
                  </td>
                  <td className="py-1 text-right">{q.impressions}</td>
                  <td className="py-1 pl-2"><PageCell path={q.path} id={q.id} title={q.title} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {o.drops.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-red-700">Collapsed — investigate</div>
          <p className="text-[11px] text-gray-400">Dropped ≥8 positions in 28 days with demand still there. Check the page still exists, is indexed, and is internally linked.</p>
          <table className="mt-1 w-full text-xs">
            <thead><tr className="border-b text-left text-[10px] uppercase text-gray-400">
              <th className="py-1">Query</th><th className="text-right">Pos now</th><th className="text-right">Δ 28d</th><th className="text-right">Impr.</th><th>Page</th>
            </tr></thead>
            <tbody>
              {o.drops.map((q) => (
                <tr key={q.query} className="border-b align-top">
                  <td className="py-1 pr-2 font-medium">{q.query}</td>
                  <td className="py-1 text-right">#{Math.round(q.position)}</td>
                  <td className="py-1 text-right font-medium text-red-600">▼{Math.abs(q.positionDelta ?? 0)}</td>
                  <td className="py-1 text-right">{q.impressions}</td>
                  <td className="py-1 pl-2">{q.path ? <a href={q.path} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{q.title ?? q.path}</a> : <span className="text-gray-400">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SearchPerformance({ companyId, data }: { companyId: string; data: SearchData }) {
  const [siteUrl, setSiteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const connect = async () => {
    if (!siteUrl.trim()) return;
    setBusy(true);
    const r = await fetch(`${API}/api/companies/${companyId}/analytics/gsc`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteUrl: siteUrl.trim() }),
    });
    setBusy(false);
    setNote(r.ok ? "Connected — first pull is running (Search Console data lags ~2 days). Reload in a few seconds." : ((await r.json().catch(() => ({}))).error ?? "Could not connect."));
  };
  const sync = async () => { setBusy(true); await fetch(`${API}/api/companies/${companyId}/analytics/sync`, { method: "POST" }); setBusy(false); setNote("Sync started — reload in a few seconds."); };
  const disconnect = async () => { await fetch(`${API}/api/companies/${companyId}/analytics/gsc`, { method: "DELETE" }); location.reload(); };

  if (!data.connected) {
    return (
      <div className="mt-4 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Google Search rankings</div>
        <p className="mt-1 text-xs text-gray-500">
          Connect your Search Console property to track clicks, impressions and <b>average position over time</b> — the real signal for whether rankings are improving. Uses the same service-account key as GA4.
        </p>
        {data.serviceAccountEmail && (
          <p className="mt-2 rounded bg-gray-50 p-2 text-[11px] text-gray-600">
            First: in Search Console → Settings → <b>Users and permissions</b> → Add user, grant <b>Full</b> or <b>Restricted</b> to:{" "}
            <code className="font-mono text-gray-800">{data.serviceAccountEmail}</code>
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">Property
            <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="datastreamnetworks.com or https://www.datastreamnetworks.com/"
              className="mt-1 block w-80 rounded border px-2 py-1" />
          </label>
          <button onClick={connect} disabled={busy} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Connecting…" : "Connect Search Console"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-gray-400">Domain property → enter the bare domain. URL-prefix property → paste the exact URL.</p>
        {note && <p className="mt-2 text-xs text-amber-700">{note}</p>}
      </div>
    );
  }

  const t = data.totals, pt = data.prevTotals;
  const posDelta = t && pt ? Math.round((pt.position - t.position) * 10) / 10 : null; // + = improved
  const histPts = (data.positionHistory ?? []).map((p) => ({ x: new Date(p.at).getTime(), y: p.position ?? 0 }));
  const dailyPts = (data.dailyTrend ?? []).map((p) => ({ x: new Date(p.date).getTime(), y: p.position }));
  const posPts = histPts.filter((p) => p.y > 0).length >= 2 ? histPts : dailyPts;
  const arrow = (d: number | null) => d == null ? "" : d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${Math.abs(d)}` : "±0";

  return (
    <div className="mt-4 rounded-xl border bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Google Search rankings</div>
          <p className="mt-1 text-xs text-gray-500">
            {data.siteUrl} · last 28 days vs previous 28
            {data.lastSyncedAt && <> · synced {new Date(data.lastSyncedAt).toLocaleDateString()}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={sync} disabled={busy} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">Sync now</button>
          <button onClick={disconnect} className="rounded-lg border px-3 py-1.5 text-xs text-red-500">Disconnect</button>
        </div>
      </div>
      {data.lastSyncError && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Search Console sync failed: {data.lastSyncError}
          {/(has not been used in project|is disabled)/i.test(data.lastSyncError) && (
            <div className="mt-1 text-red-800">
              → Enable the <b>Google Search Console API</b> in the service account's Google Cloud project (APIs &amp; Services → Library → “Search Console API” → Enable), wait a few minutes, then Sync now.
            </div>
          )}
          {/does not have sufficient permission|user does not have/i.test(data.lastSyncError) && (
            <div className="mt-1 text-red-800">
              → In Search Console → Settings → Users and permissions, add {data.serviceAccountEmail ? <code className="font-mono">{data.serviceAccountEmail}</code> : "the service-account email"} with Full or Restricted access.
            </div>
          )}
        </div>
      )}
      {note && <p className="mt-2 text-xs text-amber-700">{note}</p>}

      {t && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Clicks (28d)" value={t.clicks} highlight />
          <Stat label="Impressions (28d)" value={t.impressions} />
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-xl font-semibold">#{t.position}</div>
            <div className="text-xs text-gray-500">Avg position {posDelta != null && <span className={posDelta > 0 ? "text-green-600" : posDelta < 0 ? "text-red-600" : "text-gray-400"}>{arrow(posDelta)}</span>}</div>
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-xl font-semibold">{(t.ctr * 100).toFixed(1)}%</div>
            <div className="text-xs text-gray-500">Click-through rate</div>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Average position over time</div>
        <div className="mt-2"><PositionTrend points={posPts} label={histPts.filter((p) => p.y > 0).length >= 2 ? "per sync" : "daily (90d)"} /></div>
      </div>

      {((data.improved?.length ?? 0) > 0 || (data.declined?.length ?? 0) > 0) && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-green-700">Biggest ranking gains (28d)</div>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {(data.improved ?? []).map((q) => (
                  <tr key={q.query} className="border-b">
                    <td className="py-1 pr-2">{q.query}</td>
                    <td className="py-1 text-right text-gray-500">#{Math.round(q.position)}</td>
                    <td className="py-1 pl-2 text-right font-medium text-green-600">▲ {q.positionDelta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-red-700">Biggest drops (28d)</div>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {(data.declined ?? []).map((q) => (
                  <tr key={q.query} className="border-b">
                    <td className="py-1 pr-2">{q.query}</td>
                    <td className="py-1 text-right text-gray-500">#{Math.round(q.position)}</td>
                    <td className="py-1 pl-2 text-right font-medium text-red-600">▼ {Math.abs(q.positionDelta ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.opportunities && (
        <RankingOpportunities companyId={companyId} o={data.opportunities} />
      )}

      {(data.topQueries?.length ?? 0) > 0 && (
        <div className="mt-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Top queries by impressions</div>
          <table className="mt-1 w-full text-sm">
            <thead><tr className="border-b text-left text-[11px] uppercase text-gray-400">
              <th className="py-1">Query</th><th className="text-right">Pos</th><th className="text-right">Δ 28d</th><th className="text-right">Clicks</th><th className="text-right">Impr.</th>
            </tr></thead>
            <tbody>
              {data.topQueries!.slice(0, 25).map((q) => (
                <tr key={q.query} className="border-b">
                  <td className="py-1 pr-2">{q.query}</td>
                  <td className="py-1 text-right">#{Math.round(q.position)}</td>
                  <td className={`py-1 text-right ${q.positionDelta == null ? "text-gray-300" : q.positionDelta > 0 ? "text-green-600" : q.positionDelta < 0 ? "text-red-600" : "text-gray-400"}`}>
                    {q.positionDelta == null ? "new" : q.positionDelta > 0 ? `▲${q.positionDelta}` : q.positionDelta < 0 ? `▼${Math.abs(q.positionDelta)}` : "±0"}
                  </td>
                  <td className="py-1 text-right">{q.clicks}</td>
                  <td className="py-1 text-right text-gray-500">{q.impressions.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AnalyticsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [data, setData] = useState<Analytics | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const [form, setForm] = useState({ propertyId: "", serviceAccountKey: "" });

  const load = () => fetch(`${API}/api/companies/${companyId}/analytics`).then((r) => r.json()).then(setData);
  useEffect(() => { load(); }, [companyId]);

  const connect = async () => {
    if (!form.propertyId || !form.serviceAccountKey) return;
    setConnecting(true);
    const res = await fetch(`${API}/api/companies/${companyId}/analytics/connection`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    setConnecting(false);
    if (!res.ok) { const e = await res.json().catch(() => ({})); setNotice(e.error ?? "Could not connect — check the property ID and key."); return; }
    setForm({ propertyId: "", serviceAccountKey: "" });
    setShowConnect(false);
    setNotice("Connected — first sync is running, this can take a few seconds.");
    setTimeout(load, 4000);
    load();
  };

  const syncNow = async () => {
    setSyncing(true);
    await fetch(`${API}/api/companies/${companyId}/analytics/sync`, { method: "POST" });
    setTimeout(async () => { await load(); setSyncing(false); }, 4000);
  };

  const disconnect = async () => {
    await fetch(`${API}/api/companies/${companyId}/analytics/connection`, { method: "DELETE" });
    load();
  };

  if (!data) return <div className="py-12 text-center text-gray-400">Loading…</div>;

  if (!data.connected) {
    return (
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">Connect Google Analytics 4 to see total visitors, trends, and which posts get read.</p>

        <CompetitorVisibility companyId={companyId} />

        <div className="mt-6 rounded-xl border bg-white p-5">
          <div className="font-semibold">Connect Google Analytics 4</div>
          <p className="mt-1 text-sm text-gray-500">
            Create a Google Cloud service account, share Viewer access to your GA4 property with it, then paste its property ID and key JSON here.
          </p>
          {!showConnect ? (
            <button onClick={() => setShowConnect(true)} className="mt-3 rounded-lg border px-3 py-1.5 text-sm">+ Connect GA4 property</button>
          ) : (
            <div className="mt-3 space-y-2 rounded-lg bg-gray-50 p-3">
              <label className="block text-xs">GA4 Property ID<br />
                <input value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })}
                  placeholder="123456789" className="mt-1 w-52 rounded border px-2 py-1" />
              </label>
              <label className="block text-xs">Service account key (JSON)<br />
                <textarea value={form.serviceAccountKey} onChange={(e) => setForm({ ...form, serviceAccountKey: e.target.value })}
                  placeholder='{"client_email": "...", "private_key": "...", ...}'
                  rows={6} className="mt-1 w-full max-w-lg rounded border px-2 py-1 font-mono text-xs" />
              </label>
              <button onClick={connect} disabled={connecting} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          )}
          <p className="mt-2 text-xs text-gray-400">The key is stored encrypted and only ever used by the background sync job — never shown again after saving.</p>
          {notice && <p className="mt-2 text-xs text-amber-700">{notice}</p>}
        </div>
      </div>
    );
  }

  const trendPoints = data.trend.map((p) => ({ x: new Date(p.date).getTime(), y: p.users }));
  const totalUsers = data.totals?.totalUsers ?? 0;
  const totalSessions = data.totals?.totalSessions ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="mt-1 text-sm text-gray-500">
            Last 30 days · GA4 property {data.propertyId}
            {data.lastSyncedAt && <> · synced {new Date(data.lastSyncedAt).toLocaleString()}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncNow} disabled={syncing} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button onClick={disconnect} className="rounded-lg border px-3 py-1.5 text-sm text-red-500">Disconnect</button>
        </div>
      </div>

      {data.lastSyncError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Last sync failed: {data.lastSyncError}
        </div>
      )}
      {notice && <p className="mt-2 text-xs text-amber-700">{notice}</p>}

      <SearchPerformance companyId={companyId} data={data.search ?? { connected: false }} />
      <CompetitorVisibility companyId={companyId} />

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Total visitors (30d)" value={totalUsers} highlight />
          <Stat label="Total sessions (30d)" value={totalSessions} />
        </div>
      </div>

      <div className="mt-4 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Daily visitors</div>
        <div className="mt-3"><LineChart points={trendPoints} label="visitors / day" /></div>
      </div>

      <div className="mt-4 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Top posts by visitors</div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-gray-400">
              <th className="py-2">Post</th>
              <th className="py-2">Users</th>
              <th className="py-2">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {data.topPages.map((p) => (
              <tr key={p.blogPostId} className="border-b align-top">
                <td className="py-2 pr-3">
                  <a href={p.path} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{p.title}</a>
                </td>
                <td className="py-2">{p.users.toLocaleString()}</td>
                <td className="py-2">{p.sessions.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.topPages.length === 0 && <div className="mt-2 text-sm text-gray-400">No visits to published posts yet in this window.</div>}
      </div>
    </div>
  );
}
