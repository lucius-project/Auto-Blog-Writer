"use client";
import { use, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Post = {
  id: string; title: string; slug: string; status: string;
  scheduledFor: string | null; publishedAt: string | null; publishedUrl: string | null;
  publishError: string | null; batchRunId: string | null;
  aiCost: number; aiCalls: number;
  vertical?: { name: string } | null; location?: { city: string } | null;
  qa: { pass?: boolean; rewriteOf?: string | null } | null;
};

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700", review: "bg-gray-100 text-gray-700",
  approved: "bg-blue-100 text-blue-700", published: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700", rejected: "bg-gray-200 text-gray-500",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "in review queue", review: "in review queue", approved: "on site scheduler",
  published: "published", failed: "publish failed", rejected: "rejected",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export default function Posts({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [posts, setPosts] = useState<Post[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [start, setStart] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState<string>("09:00");
  const [perWeek, setPerWeek] = useState(3);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [costOpen, setCostOpen] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState<string | null>(null);
  const [panelDate, setPanelDate] = useState<string>("");
  const [costDetail, setCostDetail] = useState<Record<string, { models: { model: string; calls: number; cost: number }[]; total: number; estimatedAttribution: boolean } | null>>({});

  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/posts`).then((r) => r.json()).then(setPosts), [companyId]);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // bulk scheduling moves DRAFTS out of review — approved/published posts have their dates already
  const schedulable = posts.filter((p) => ["draft", "review"].includes(p.status));

  const runBatch = async () => {
    const ids = [...sel];
    if (!ids.length) { setMsg("Select at least one draft below first."); return; }
    const startIso = new Date(start + "T" + (startTime || "09:00") + ":00").toISOString();
    const r = await fetch(`${API}/api/companies/${companyId}/schedule-batch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ postIds: ids, start: startIso, perWeek }),
    }).then((r) => r.json());
    const past = new Date(start) < new Date(new Date().toISOString().slice(0, 10));
    const skipped = (r.skipped ?? []) as { title: string; reason: string }[];
    setMsg(
      `${r.scheduled?.length ?? 0} draft${(r.scheduled?.length ?? 0) === 1 ? "" : "s"} approved and ${past ? "backfilled" : "scheduled"} starting ${start}, ${perWeek}/week.` +
      (skipped.length ? ` Skipped ${skipped.length}: ${skipped.map((s) => `“${s.title.slice(0, 40)}” (${s.reason})`).join("; ")}` : ""),
    );
    setSel(new Set());
    load();
  };

  const reschedule = async (id: string, dt: string) => {
    if (!dt) return;
    await fetch(`${API}/api/posts/${id}/reschedule`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduledFor: new Date(dt).toISOString() }),
    });
    load();
  };

  const money = (v: number) => "$" + v.toFixed(5);
  const toggleCost = async (id: string) => {
    if (costOpen === id) { setCostOpen(null); return; }
    setCostOpen(id);
    if (!costDetail[id]) {
      const d = await fetch(`${API}/api/posts/${id}/cost`).then((r) => r.json()).catch(() => null);
      setCostDetail((c) => ({ ...c, [id]: d }));
    }
  };

  const retry = async (id: string, when?: string) => {
    setBusy(id);
    const r = await fetch(`${API}/api/posts/${id}/retry-publish`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(when ? { scheduledFor: new Date(when).toISOString() } : {}),
    }).then((r) => r.json());
    setBusy(null);
    setPanelOpen(null); setPanelDate("");
    setMsg(r.ok ? (r.action === "scheduled" ? `Retrying — back on the scheduler for ${fmt(r.scheduledFor)}.` : "Retrying — publishing now.") : `Retry failed: ${r.error ?? ""}`);
    load();
  };

  const doReschedule = async (id: string) => {
    if (!panelDate) { setMsg("Pick a date and time first."); return; }
    setBusy(id);
    await reschedule(id, panelDate);
    setBusy(null);
    setPanelOpen(null); setPanelDate("");
    setMsg(`Moved to ${fmt(new Date(panelDate).toISOString())} — pushed to the site scheduler.`);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">Posts & schedule</h1>
      <p className="mt-1 text-sm text-gray-500">
        Timing lives here; editorial decisions live in the <a href={`/review/${companyId}`} className="text-blue-600 underline">Review queue</a>.
        “On site scheduler” means the article is already pushed to the CMS and goes live at its date automatically.
      </p>

      <div className="mt-4 rounded-xl border bg-white p-4">
        <div className="text-sm font-semibold">Schedule review-queue drafts across a window</div>
        <p className="mt-1 text-xs text-gray-500">
          Approves the selected drafts and spreads them from the start date at your weekly pace (work hours, random 36–62 min gaps).
          Only drafts can be selected — already-scheduled or published posts keep their dates.
          A past start date backfills: posts publish now carrying the past date (established history, but no AI freshness value).
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox"
              checked={sel.size > 0 && sel.size === schedulable.length}
              onChange={(e) => setSel(e.target.checked ? new Set(schedulable.map((p) => p.id)) : new Set())} />
            Select all drafts ({schedulable.length})
          </label>
          <label className="text-sm">Start date<br />
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 rounded border px-2 py-1" />
          </label>
          <label className="text-sm">Start time<br />
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-1 rounded border px-2 py-1" />
          </label>
          <label className="text-sm">Posts per week<br />
            <input type="number" min={1} max={14} value={perWeek} onChange={(e) => setPerWeek(Number(e.target.value))} className="mt-1 w-24 rounded border px-2 py-1" />
          </label>
          <button onClick={runBatch} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
            Approve & schedule {sel.size ? `${sel.size} draft${sel.size === 1 ? "" : "s"}` : "selected drafts"}
          </button>
        </div>
        {msg && <div className="mt-2 rounded bg-blue-50 p-2 text-sm text-blue-900">{msg}</div>}
      </div>

      <table className="mt-6 w-full text-sm">
        <thead><tr className="border-b text-left text-xs uppercase text-gray-400">
          <th className="py-2"></th><th>Title</th><th>Status</th><th>Date</th><th>AI cost</th><th></th>
        </tr></thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="border-b align-top">
              <td className="py-2 pr-2">
                {["draft", "review"].includes(p.status) &&
                  <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />}
              </td>
              <td className="py-2 pr-3">
                <div className="font-medium">{p.title}</div>
                <div className="text-xs text-gray-400">/blog/{p.slug} · {p.vertical?.name ?? "general"}{p.qa?.pass === false ? " · QA FAIL" : ""}</div>
                {p.status === "failed" && p.publishError && (
                  <div className="mt-1 max-w-xl text-xs text-red-600">{p.publishError.slice(0, 180)}</div>
                )}
              </td>
              <td className="py-2 pr-3">
                <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? ""}`}>
                  {STATUS_LABEL[p.status] ?? p.status}
                </span>
              </td>
              <td className="py-2 pr-3 text-xs text-gray-600">
                {p.status === "published" ? fmt(p.publishedAt) : p.scheduledFor ? fmt(p.scheduledFor) : "—"}
              </td>
              <td className="py-2 pr-3 text-xs">
                {p.aiCost > 0 ? (
                  <button onClick={() => toggleCost(p.id)} className="font-mono text-gray-700 underline decoration-dotted" title="Click for the per-model breakdown">
                    {money(p.aiCost)}
                  </button>
                ) : <span className="text-gray-300">—</span>}
                {costOpen === p.id && (
                  <div className="mt-2 w-64 rounded-lg border bg-gray-50 p-2 font-mono text-[11px]">
                    {!costDetail[p.id] && <div className="text-gray-400">loading…</div>}
                    {costDetail[p.id]?.models.map((m) => (
                      <div key={m.model} className="flex justify-between gap-2">
                        <span className="truncate">{m.model.replace(/^.*\//, "")} ×{m.calls}</span>
                        <span>{money(m.cost)}</span>
                      </div>
                    ))}
                    {costDetail[p.id] && (
                      <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                        <span>total</span><span>{money(costDetail[p.id]!.total)}</span>
                      </div>
                    )}
                    {costDetail[p.id]?.estimatedAttribution && (
                      <div className="mt-1 font-sans text-[10px] text-gray-400">includes pre-tracking calls matched by timestamp</div>
                    )}
                  </div>
                )}
              </td>
              <td className="py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {["draft", "review"].includes(p.status) && (
                    <a href={`/review/${companyId}`} className="text-blue-600">review →</a>
                  )}
                  {p.status === "failed" && (
                    <button onClick={() => { setPanelOpen(panelOpen === p.id ? null : p.id); setPanelDate(""); }}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white">
                      {panelOpen === p.id ? "Close" : "Retry publish…"}
                    </button>
                  )}
                  {p.status === "approved" && (
                    <button onClick={() => { setPanelOpen(panelOpen === p.id ? null : p.id); setPanelDate(""); }}
                      className="rounded border px-2 py-1">
                      {panelOpen === p.id ? "Close" : "Change date…"}
                    </button>
                  )}
                  {p.publishedUrl && <a className="text-blue-600" href={p.publishedUrl} target="_blank">view ↗</a>}
                </div>
                {panelOpen === p.id && p.status === "failed" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-50 p-2">
                    <button disabled={busy === p.id} onClick={() => retry(p.id)}
                      className="rounded bg-red-600 px-2.5 py-1.5 font-medium text-white disabled:opacity-50">
                      {busy === p.id ? "…" : "Retry now"}
                    </button>
                    <span className="text-gray-400">or</span>
                    <input type="datetime-local" value={panelDate} onChange={(e) => setPanelDate(e.target.value)}
                      className="rounded border px-1.5 py-1" />
                    <button disabled={busy === p.id || !panelDate} onClick={() => retry(p.id, panelDate)}
                      className="rounded bg-red-600 px-2.5 py-1.5 font-medium text-white disabled:opacity-40">
                      Retry at this time
                    </button>
                  </div>
                )}
                {panelOpen === p.id && p.status === "approved" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-blue-50 p-2">
                    <input type="datetime-local" value={panelDate} onChange={(e) => setPanelDate(e.target.value)}
                      className="rounded border px-1.5 py-1" />
                    <button disabled={busy === p.id || !panelDate} onClick={() => doReschedule(p.id)}
                      className="rounded bg-blue-600 px-2.5 py-1.5 font-medium text-white disabled:opacity-40">
                      Move to this date & time
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
          {posts.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-gray-400">No posts yet — write a batch from the dashboard.</td></tr>}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-400">
        {schedulable.length} in review · {posts.length} total · AI spend across these posts:{" "}
        <span className="font-mono">{money(posts.reduce((a, p) => a + (p.aiCost || 0), 0))}</span>
      </p>
    </div>
  );
}
