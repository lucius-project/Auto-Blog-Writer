"use client";
import { use, useCallback, useEffect, useState } from "react";
import { CHECKLIST_CATEGORIES, needsWork, type ChecklistItem } from "@abw/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Data = {
  status: "never_run" | "idle" | "queued" | "running" | "failed";
  error: string | null;
  liveFetchedAt: string | null;
  score: number | null;
  items: ChecklistItem[];
};

const BADGE: Record<string, { label: string; cls: string; icon: string }> = {
  pass: { label: "Pass", cls: "bg-green-100 text-green-800", icon: "✓" },
  warn: { label: "Improve", cls: "bg-amber-100 text-amber-800", icon: "!" },
  fail: { label: "Fix", cls: "bg-red-100 text-red-700", icon: "✕" },
  manual: { label: "To do", cls: "bg-gray-100 text-gray-700", icon: "○" },
  done: { label: "Done", cls: "bg-green-100 text-green-800", icon: "✓" },
};
const IMPACT: Record<string, string> = { high: "High impact", medium: "Medium impact", low: "Low impact" };
const RANK: Record<string, number> = { fail: 0, warn: 1, manual: 2, pass: 3 };
const IMPACT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export default function ChecklistPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"todo" | "all">("todo");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/checklist`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !Array.isArray(d.items)) throw new Error(d?.error ?? `HTTP ${r.status}`);
        setData(d);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message || "network error")), [companyId]);
  useEffect(() => { load(); }, [load]);

  const running = data?.status === "queued" || data?.status === "running";
  // poll while a run is in progress
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  const run = async () => {
    await fetch(`${API}/api/companies/${companyId}/checklist/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    load();
  };
  const tick = async (key: string, done: boolean) => {
    setData((d) => d && { ...d, items: d.items.map((it) => (it.key === key ? { ...it, done } : it)) });
    await fetch(`${API}/api/companies/${companyId}/checklist/${encodeURIComponent(key)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ done }),
    });
    load();
  };

  const items = data?.items ?? [];
  const todo = items.filter(needsWork);
  const shown = (filter === "todo" ? todo : items).slice().sort((a, b) =>
    (RANK[a.status]! - RANK[b.status]!) || (IMPACT_RANK[a.impact]! - IMPACT_RANK[b.impact]!));
  const score = data?.score ?? null;
  const scoreColor = score === null ? "text-gray-400" : score >= 80 ? "text-green-600" : score >= 50 ? "text-amber-600" : "text-red-600";

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Website checklist</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            What search engines and AI assistants look for on your own site: a page per location, a deep page per industry,
            the two tied together, visible reviews, and the technical basics. Automated items are re-checked live on every run;
            off-site items are yours to tick off.
          </p>
        </div>
        <button onClick={run} disabled={running}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {running ? "Checking site…" : data?.status === "never_run" ? "Run first check" : "Re-run check"}
        </button>
      </div>

      {loadError && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn&apos;t load the checklist ({loadError}). <button className="ml-1 font-semibold underline" onClick={load}>Retry</button>
        </div>
      )}
      {data?.status === "failed" && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Last run failed: {data.error}</div>
      )}

      {data?.status === "never_run" && !running && (
        <div className="mt-6 rounded-xl border border-dashed p-8 text-center text-gray-500">
          No checks yet. <button onClick={run} className="font-semibold text-gray-900 underline">Run the first check</button> — it takes about a minute.
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border bg-white p-4">
              <div className="text-xs font-semibold uppercase text-gray-400">Score</div>
              <div className={`mt-1 text-3xl font-bold ${scoreColor}`}>{score ?? "—"}<span className="text-base font-medium text-gray-400">/100</span></div>
            </div>
            {(["fail", "warn", "manual"] as const).map((s) => {
              const n = items.filter((it) => it.status === s && (s !== "manual" || !it.done)).length;
              return (
                <div key={s} className="rounded-xl border bg-white p-4">
                  <div className="text-xs font-semibold uppercase text-gray-400">{s === "fail" ? "To fix" : s === "warn" ? "To improve" : "Off-site to do"}</div>
                  <div className="mt-1 text-3xl font-bold">{n}</div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex gap-1 rounded-lg border bg-white p-1">
              {(["todo", "all"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`rounded-md px-3 py-1 ${filter === f ? "bg-gray-900 text-white" : "text-gray-600"}`}>
                  {f === "todo" ? `Needs work (${todo.length})` : `All (${items.length})`}
                </button>
              ))}
            </div>
            {data?.liveFetchedAt && <span className="text-xs text-gray-400">Checked {new Date(data.liveFetchedAt).toLocaleString()}</span>}
          </div>

          <div className="mt-4 space-y-6">
            {CHECKLIST_CATEGORIES.map((cat) => {
              const group = shown.filter((it) => it.category === cat);
              if (!group.length) return null;
              return (
                <div key={cat}>
                  <div className="text-xs font-semibold uppercase text-gray-400">{cat} ({group.length})</div>
                  <div className="mt-2 divide-y rounded-xl border bg-white">
                    {group.map((it) => {
                      const b = BADGE[it.status === "manual" && it.done ? "done" : it.status]!;
                      const expanded = openKey === it.key;
                      return (
                        <div key={it.key} className="p-4">
                          <div className="flex items-start gap-3">
                            {it.status === "manual" ? (
                              <input type="checkbox" checked={!!it.done} onChange={(e) => tick(it.key, e.target.checked)}
                                className="mt-1 h-4 w-4 shrink-0 accent-green-600" aria-label={`Mark "${it.title}" done`} />
                            ) : (
                              <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${b.cls}`} aria-hidden>{b.icon}</span>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`font-medium ${it.status === "manual" && it.done ? "text-gray-400 line-through" : ""}`}>{it.title}</span>
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${b.cls}`}>{b.label}</span>
                                <span className="text-[11px] text-gray-400">{IMPACT[it.impact]}</span>
                              </div>
                              <p className="mt-0.5 break-words text-sm text-gray-600">{it.detail}</p>
                              {it.url && (
                                <a href={it.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block break-all text-xs text-blue-600 hover:underline">
                                  {it.url.replace(/^https?:\/\/(www\.)?/, "")} ↗
                                </a>
                              )}
                              {(it.status !== "pass") && (
                                <div className="mt-2">
                                  <button onClick={() => setOpenKey(expanded ? null : it.key)} className="text-xs font-medium text-gray-900 underline">
                                    {expanded ? "Hide how to fix" : "How to fix"}
                                  </button>
                                  {expanded && <p className="mt-1 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">{it.fix}</p>}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="rounded-xl border border-dashed p-8 text-center text-gray-400">Nothing left to do. Re-run the check after site changes.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
