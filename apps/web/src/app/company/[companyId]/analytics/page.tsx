"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type TrendPoint = { date: string; users: number; sessions: number };
type TopPage = { path: string; blogPostId: string; title: string; users: number; sessions: number };
type Analytics = {
  connected: boolean;
  propertyId?: string;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  totals?: { totalUsers: number; totalSessions: number } | null;
  trend: TrendPoint[];
  topPages: TopPage[];
  liveFetchedAt?: string | null;
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
