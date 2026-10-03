"use client";
import { use, useCallback, useEffect, useMemo, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Hit = { rank: number | null; packRank: number | null; ai: boolean; points: number };
type Score = {
  domain: string; queries: number; score: number; top3Rate: number; top10Rate: number; avgRank: number | null;
  localPackRate: number; aiRate: number; aiEligible: number; winsVsTenant: number;
};
type Row = Score & { isTenant: boolean; label: string | null; content: { pages: number; questions: number; posts: number }; crawl: { status: string; error: string | null } | null };

const fmtDate = (d: string | Date) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const scoreColor = (s: number) => (s >= 30 ? "text-green-700" : s >= 10 ? "text-amber-700" : "text-gray-500");

export default function Competitors({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState({ city: "", vertical: "", outcome: "loss" });

  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/benchmark`).then((r) => r.json()).then(setD).catch(() => {}), [companyId]);
  useEffect(() => { load(); }, [load]);
  // live progress while a run is going
  useEffect(() => {
    if (!d?.running) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [d?.running, load]);

  const post = async (path: string, body: unknown, note: string) => {
    const r = await fetch(`${API}/api/companies/${companyId}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    setMsg(r.ok ? note : `Failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    setTimeout(load, 1500);
  };

  const latest = d?.latest;
  const cities = useMemo(() => [...new Set<string>((latest?.queries ?? []).map((q: any) => q.city))].sort(), [latest]);
  const verticals = useMemo(() => [...new Set<string>((latest?.queries ?? []).map((q: any) => q.vertical))].sort(), [latest]);
  const queries = (latest?.queries ?? []).filter((q: any) =>
    (!filter.city || q.city === filter.city) && (!filter.vertical || q.vertical === filter.vertical) && (!filter.outcome || q.outcome === filter.outcome));
  const tracked: Row[] = latest?.scorecard?.filter((r: Row) => !r.isTenant) ?? [];

  if (!d) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Competitors</h1>
          <p className="mt-1 text-sm text-gray-600">
            You vs the competitors you track, on the searches your customers actually run — generated from each
            industry’s BrandScript and searched live on Google from each city.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button disabled={!!d.running || !d.queryCount}
            onClick={() => post("/benchmark/run", {}, `Benchmark started — ${d.queryCount} live searches, about ${Math.ceil(d.queryCount / 30)} min. This page updates itself.`)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {d.running ? `⏳ Running… ${d.running.queriesProbed}/${d.running.queriesTotal}` : "Run benchmark now"}
          </button>
        </div>
      </div>
      {msg && <div className="mt-3 rounded bg-blue-50 p-2 text-sm text-blue-900">{msg} <button className="underline" onClick={() => setMsg(null)}>dismiss</button></div>}

      {!d.queryCount && (
        <div className="mt-6 rounded-xl border bg-white p-5">
          <div className="font-semibold">No benchmark searches yet</div>
          <p className="mt-1 text-sm text-gray-600">
            Generate the search set from your BrandScripts: general local searches for each city plus industry-specific
            searches for each city × industry, written in your customers’ own words.
          </p>
          <button onClick={() => post("/benchmark/generate", { runAfter: true }, "Generating searches, then running the first benchmark — takes a few minutes.")}
            className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white">
            Generate searches & run first benchmark
          </button>
        </div>
      )}

      {d.queryCount > 0 && !latest && !d.running && (
        <div className="mt-6 rounded-xl border bg-white p-5 text-sm text-gray-600">
          {d.queryCount} searches ready. {d.runs?.[0]?.status === "failed" ? <span className="text-red-600">Last run failed: {d.runs[0].error}</span> : "Run the benchmark to see the comparison."}
        </div>
      )}

      {latest && (
        <>
          <p className="mt-3 text-xs text-gray-500">
            Live results fetched {fmtDate(latest.liveFetchedFrom)}{latest.liveFetchedTo && ` – ${fmtDate(latest.liveFetchedTo)}`} · {latest.queriesProbed} searches.
            Re-measured monthly by the weekly run.
            {latest.queriesProbed < latest.queriesTotal && !d.running && (
              <> <span className="text-amber-700">{latest.queriesTotal - latest.queriesProbed} searches failed at the data provider.</span>{" "}
                <button className="text-blue-600 underline" onClick={() => post("/benchmark/run", { resumeRunId: latest.runId }, "Retrying the failed searches — this page updates itself.")}>Retry them</button></>
            )}
          </p>

          {/* ---- scorecard ---- */}
          <div className="mt-4 overflow-x-auto rounded-xl border bg-white">
            <div className="p-5 pb-2">
              <div className="font-semibold">Scorecard</div>
              <p className="mt-1 text-xs text-gray-500">
                <b>Visibility</b> (0–100) = 50% Google rank (position-weighted) + 25% map pack + 25% cited in Google’s AI Overview, averaged over all searches.
                <b> Beats you</b> = searches where they out-rank you.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2">Company</th>
                  <th className="px-3 py-2 text-right">Visibility</th>
                  <th className="px-3 py-2 text-right">Top 3</th>
                  <th className="px-3 py-2 text-right">Top 10</th>
                  <th className="px-3 py-2 text-right">Avg rank</th>
                  <th className="px-3 py-2 text-right">Map pack</th>
                  <th className="px-3 py-2 text-right">AI Overview</th>
                  <th className="px-3 py-2 text-right">Beats you</th>
                  <th className="px-3 py-2 text-right">Pages · questions</th>
                </tr>
              </thead>
              <tbody>
                {latest.scorecard.map((r: Row) => (
                  <tr key={r.domain} className={`border-b last:border-0 ${r.isTenant ? "bg-blue-50/60 font-medium" : ""}`}>
                    <td className="px-4 py-2">
                      <div>{r.isTenant ? `You (${r.domain})` : r.label || r.domain}</div>
                      {!r.isTenant && r.label && <div className="text-xs text-gray-400">{r.domain}</div>}
                      {r.crawl?.status === "failed" && <div className="text-xs text-amber-700">content not crawled: {r.crawl.error}</div>}
                    </td>
                    <td className={`px-3 py-2 text-right text-base font-semibold ${scoreColor(r.score)}`}>{r.score}</td>
                    <td className="px-3 py-2 text-right">{r.top3Rate}%</td>
                    <td className="px-3 py-2 text-right">{r.top10Rate}%</td>
                    <td className="px-3 py-2 text-right">{r.avgRank ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{r.localPackRate}%</td>
                    <td className="px-3 py-2 text-right">{r.aiEligible ? `${r.aiRate}%` : "—"}</td>
                    <td className="px-3 py-2 text-right">{r.isTenant ? "" : r.winsVsTenant}</td>
                    <td className="px-3 py-2 text-right text-xs text-gray-600">{r.content.pages} · {r.content.questions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- by city x industry ---- */}
          <div className="mt-6 overflow-x-auto rounded-xl border bg-white">
            <div className="p-5 pb-2">
              <div className="font-semibold">Who leads each market</div>
              <p className="mt-1 text-xs text-gray-500">Each city × industry segment scored on its own searches. Click a row to see its searches below.</p>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-xs text-gray-500">
                <tr><th className="px-4 py-2">City</th><th className="px-3 py-2">Industry</th><th className="px-3 py-2 text-right">Searches</th><th className="px-3 py-2 text-right">You</th><th className="px-3 py-2">Top tracked competitor</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {latest.segments.map((s: any) => {
                  const lead = s.leader?.score ?? 0;
                  const status = s.you === 0 && lead === 0 ? ["Nobody tracked is visible — open field", "bg-gray-100 text-gray-600"]
                    : s.you > lead ? ["You lead", "bg-green-100 text-green-800"]
                    : s.you === lead ? ["Tied", "bg-gray-100 text-gray-700"]
                    : [`Behind by ${Math.round((lead - s.you) * 10) / 10}`, "bg-red-100 text-red-800"];
                  return (
                    <tr key={`${s.locationId}|${s.verticalId}`} className="cursor-pointer border-b last:border-0 hover:bg-gray-50"
                      onClick={() => setFilter({ city: s.city, vertical: s.vertical, outcome: "" })}>
                      <td className="px-4 py-2">{s.city}</td>
                      <td className="px-3 py-2">{s.vertical}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{s.queries}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${scoreColor(s.you)}`}>{s.you}</td>
                      <td className="px-3 py-2">{s.leader ? <>{s.leader.domain} <span className="font-semibold">{s.leader.score}</span></> : <span className="text-gray-400">—</span>}</td>
                      <td className="px-3 py-2"><span className={`rounded px-2 py-0.5 text-xs ${status[1]}`}>{status[0]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ---- trend ---- */}
          {d.trend.length > 1 && (
            <div className="mt-6 overflow-x-auto rounded-xl border bg-white">
              <div className="p-5 pb-2 font-semibold">Trend (visibility score per run)</div>
              <table className="w-full text-sm">
                <thead className="border-b bg-gray-50 text-left text-xs text-gray-500">
                  <tr><th className="px-4 py-2">Run</th><th className="px-3 py-2 text-right">You</th>
                    {tracked.map((c) => <th key={c.domain} className="px-3 py-2 text-right">{c.label || c.domain}</th>)}</tr>
                </thead>
                <tbody>
                  {[...d.trend].reverse().map((t: any) => (
                    <tr key={t.at} className="border-b last:border-0">
                      <td className="px-4 py-2">{new Date(t.at).toLocaleDateString()}</td>
                      <td className="px-3 py-2 text-right font-semibold">{t.summary?.tenant?.score ?? "—"}</td>
                      {tracked.map((c) => (
                        <td key={c.domain} className="px-3 py-2 text-right">{t.summary?.competitors?.find((x: any) => x.domain === c.domain)?.score ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- per search ---- */}
          <div className="mt-6 rounded-xl border bg-white p-5">
            <div className="font-semibold">Search by search</div>
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <select value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })} className="rounded border px-2 py-1">
                <option value="">All outcomes</option><option value="loss">A competitor beats you</option><option value="win">You win</option><option value="tie">Tied</option><option value="none">Nobody tracked visible</option>
              </select>
              <select value={filter.city} onChange={(e) => setFilter({ ...filter, city: e.target.value })} className="rounded border px-2 py-1">
                <option value="">All cities</option>{cities.map((c) => <option key={c}>{c}</option>)}
              </select>
              <select value={filter.vertical} onChange={(e) => setFilter({ ...filter, vertical: e.target.value })} className="rounded border px-2 py-1">
                <option value="">All industries</option>{verticals.map((v) => <option key={v}>{v}</option>)}
              </select>
              <span className="self-center text-xs text-gray-500">{queries.length} searches</span>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-gray-500">
                  <tr><th className="py-2 pr-3">Search</th><th className="px-3 py-2">You</th><th className="px-3 py-2">Best tracked competitor</th><th className="px-3 py-2">Top 3 on Google</th></tr>
                </thead>
                <tbody>
                  {queries.slice(0, 200).map((q: any) => (
                    <tr key={q.queryId} className="border-b align-top last:border-0">
                      <td className="py-2 pr-3">
                        <div>{q.query}</div>
                        <div className="text-xs text-gray-400">{q.city} · {q.vertical} · {q.intent}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap"><HitCell h={q.you} hasAi={q.hasAiOverview} /></td>
                      <td className="px-3 py-2">{q.competitor ? <><div className="text-xs text-gray-600">{q.competitor.domain}</div><HitCell h={q.competitor} hasAi={q.hasAiOverview} /></> : <span className="text-gray-400">—</span>}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{q.topOrganic.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- untracked ---- */}
          {latest.untracked.length > 0 && (
            <div className="mt-6 rounded-xl border bg-white p-5">
              <div className="font-semibold">Also winning these searches (not tracked)</div>
              <p className="mt-1 text-xs text-gray-500">Other sites showing up on your customers’ searches. Track the real competitors so they appear in the scorecard. Directories and platforms are where you get listed, not who you beat.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {latest.untracked.map((u: any) => (
                  <span key={u.domain} className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs">
                    {u.domain} <b>{u.score}</b>
                    {u.platform ? <span className="text-gray-400">platform</span> : (
                      <button className="text-blue-600 underline" onClick={async () => {
                        const r = await fetch(`${API}/api/companies/${companyId}/competitors`, {
                          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: u.domain }),
                        });
                        setMsg(r.ok ? `Tracking ${u.domain} — it appears in the scorecard now (crawl its content from Settings → Competitors).` : `Couldn't add ${u.domain}`);
                        load();
                      }}>track</button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {d.queryCount > 0 && <QuerySet companyId={companyId} onNotice={setMsg} reload={load} />}
    </div>
  );
}

function HitCell({ h, hasAi }: { h: Hit; hasAi: boolean }) {
  const parts: string[] = [];
  if (h.rank != null) parts.push(`#${h.rank} Google`);
  if (h.packRank != null) parts.push(`map #${h.packRank}`);
  if (h.ai) parts.push("AI cited");
  if (!parts.length) return <span className="text-xs text-red-600">not found{hasAi ? " · not in AI" : ""}</span>;
  return <span className={`text-xs ${h.rank != null && h.rank <= 3 ? "font-semibold text-green-700" : "text-gray-700"}`}>{parts.join(" · ")}</span>;
}

function QuerySet({ companyId, onNotice, reload }: { companyId: string; onNotice: (m: string) => void; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [company, setCompany] = useState<any>(null);
  const [draft, setDraft] = useState({ query: "", locationId: "", verticalId: "" });
  const load = useCallback(() => {
    fetch(`${API}/api/companies/${companyId}/benchmark/queries`).then((r) => r.json()).then(setRows);
    fetch(`${API}/api/companies/${companyId}/full`).then((r) => r.json()).then(setCompany);
  }, [companyId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const cityOf = new Map<string, string>((company?.locations ?? []).map((l: any) => [l.id, l.city]));
  const verticalOf = new Map<string, string>((company?.locations ?? []).flatMap((l: any) => l.verticals.map((v: any) => [v.id, v.name])));
  const loc = (company?.locations ?? []).find((l: any) => l.id === draft.locationId);

  const call = async (method: string, path: string, body?: unknown) => {
    await fetch(`${API}/api/companies/${companyId}/benchmark/queries${path}`, {
      method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    load(); reload();
  };

  return (
    <div className="mt-6 rounded-xl border bg-white p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between font-semibold">
        <span>Benchmark searches</span><span className="text-xs font-normal text-gray-500">{open ? "hide" : "manage"}</span>
      </button>
      {open && (
        <>
          <p className="mt-1 text-xs text-gray-500">
            Keep this set stable so runs compare like-for-like. Paused searches are skipped. Each search costs one live lookup per run.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
            <input placeholder="add a search, e.g. IT support for dental clinics Victoria" value={draft.query}
              onChange={(e) => setDraft({ ...draft, query: e.target.value })} className="min-w-64 flex-1 rounded border px-2 py-1" />
            <select value={draft.locationId} onChange={(e) => setDraft({ ...draft, locationId: e.target.value, verticalId: "" })} className="rounded border px-2 py-1">
              <option value="">City…</option>{(company?.locations ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.city}</option>)}
            </select>
            <select value={draft.verticalId} onChange={(e) => setDraft({ ...draft, verticalId: e.target.value })} className="rounded border px-2 py-1">
              <option value="">General local</option>{(loc?.verticals ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <button disabled={!draft.query || !draft.locationId} className="rounded bg-gray-900 px-3 py-1 text-white disabled:opacity-50"
              onClick={async () => {
                await call("POST", "", { query: draft.query, locationId: draft.locationId, verticalId: draft.verticalId || null, intent: draft.verticalId ? "vertical" : "local" });
                setDraft({ ...draft, query: "" });
              }}>Add</button>
            <button className="rounded border px-3 py-1 text-xs" onClick={async () => {
              if (!confirm("Replace all auto-generated searches with a fresh set from the current BrandScripts? Manual searches are kept. Earlier runs used different searches, so compare trends from the next run on.")) return;
              await fetch(`${API}/api/companies/${companyId}/benchmark/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace: true }) });
              onNotice("Regenerating searches from the BrandScripts — a couple of minutes.");
            }}>Regenerate from BrandScripts</button>
          </div>
          <div className="mt-3 max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} className={`border-b last:border-0 ${q.active ? "" : "text-gray-400"}`}>
                    <td className="py-1 pr-2">{q.query}{q.source === "manual" && <span className="ml-1 text-xs text-blue-600">manual</span>}</td>
                    <td className="px-2 py-1 text-xs text-gray-500">{cityOf.get(q.locationId)} · {q.verticalId ? verticalOf.get(q.verticalId) : "General local"}</td>
                    <td className="px-2 py-1 text-right text-xs whitespace-nowrap">
                      <button className="underline" onClick={() => call("PATCH", `/${q.id}`, { active: !q.active })}>{q.active ? "pause" : "resume"}</button>
                      <button className="ml-2 text-red-500" onClick={() => call("DELETE", `/${q.id}`)}>delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
