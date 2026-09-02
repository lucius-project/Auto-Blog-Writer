"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Node = {
  id: string; question: string; category: string; funnelStage: string;
  status: string; score: number | null; source: string; blogPostId?: string | null;
  evidence: { hasAiOverview?: boolean; tenantInAiOverview?: boolean; competitorsCited?: string[]; liveFetchedAt?: string } | null;
};

const CHIP: Record<string, string> = {
  unanswered: "bg-red-100 text-red-700", answered_weak: "bg-amber-100 text-amber-700",
  answered_strong: "bg-green-100 text-green-700", competitor_owned: "bg-purple-100 text-purple-700",
  stale: "bg-gray-200 text-gray-600",
};

function OwnerAdd({ companyId }: { companyId: string }) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = async () => {
    if (q.length < 8) return;
    await fetch(`${API}/api/companies/${companyId}/topics`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q }),
    });
    setMsg(`Added with top priority: "${q}"`);
    setQ("");
  };
  return (
    <div className="mt-4 rounded-xl border bg-white p-4">
      <div className="text-sm font-semibold">Add your own question / keyword topic</div>
      <p className="mt-1 text-xs text-gray-500">Anything you want to rank for — phrased how a buyer would ask an AI. Owner-added topics jump to the top of the writing priority.</p>
      <div className="mt-2 flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="e.g. How much does IT support cost for a dental office in Salt Lake City?"
          className="w-full rounded border px-3 py-2 text-sm" />
        <button onClick={add} className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">Add</button>
      </div>
      {msg && <div className="mt-2 text-xs text-green-700">{msg}</div>}
    </div>
  );
}

export default function Topics({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const write = async (id: string) => {
    await fetch(`${API}/api/topics/${id}/generate`, { method: "POST" });
    setQueued((q) => new Set(q).add(id));
  };
  const rewrite = async (id: string, blogPostId: string) => {
    await fetch(`${API}/api/posts/${blogPostId}/rewrite`, { method: "POST" });
    setQueued((q) => new Set(q).add(id));
  };
  useEffect(() => {
    fetch(`${API}/api/companies/${companyId}/topics?take=1000${filter ? `&status=${filter}` : ""}${sourceFilter ? `&source=${sourceFilter}` : ""}`)
      .then((r) => r.json()).then(setNodes);
  }, [companyId, filter, sourceFilter]);
  return (
    <div>
      <h1 className="text-2xl font-bold">Topic Graph</h1>
      <p className="mt-1 text-sm text-gray-500">Every question your buyers could ask an AI, ranked by value. This is the backlog the weekly loop drains.</p>
      <OwnerAdd companyId={companyId} />
      <div className="mt-4 flex flex-wrap gap-1">
        {["", "unanswered", "answered_weak", "answered_strong", "competitor_owned", "stale"].map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={`rounded-lg px-3 py-1 text-xs font-medium ${filter === s ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600"}`}>
            {s ? s.replace("_", " ") : "all"}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] uppercase text-gray-400">source</span>
        {[["", "any"], ["taxonomy", "taxonomy"], ["research", "buyer research"], ["competitor", "competitor"], ["paa", "people-also-ask"], ["fanout", "expanded"], ["news", "news"]].map(([s, label]) => (
          <button key={s} onClick={() => setSourceFilter(s)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium ${sourceFilter === s ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600"}`}>
            {label}
          </button>
        ))}
        <span className="ml-2 text-xs text-gray-400">{nodes.length} shown</span>
      </div>
      <div className="mt-4 space-y-2">
        {nodes.map((n) => (
          <div key={n.id} className="rounded-lg border bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-medium">{n.question}</div>
              <div className="flex shrink-0 items-center gap-2">
                {n.score != null && <span className="text-xs font-semibold text-gray-500">{Math.round(n.score)}</span>}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[n.status] ?? ""}`}>{n.status.replace("_", " ")}</span>
                {n.status !== "answered_strong" && !n.blogPostId && (
                  queued.has(n.id)
                    ? <span className="text-xs text-green-600">queued ✓</span>
                    : <button onClick={() => write(n.id)} className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white">Write article</button>
                )}
                {["answered_weak", "stale"].includes(n.status) && n.blogPostId && (
                  queued.has(n.id)
                    ? <span className="text-xs text-green-600">rewriting ✓</span>
                    : <button onClick={() => rewrite(n.id, n.blogPostId!)} title="Regenerate this article in place — the new version lands in review and updates the same page on approve"
                        className="rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white">Rewrite & strengthen</button>
                )}
              </div>
            </div>
            <div className="mt-1 text-xs text-gray-400">
              {n.category} · {n.funnelStage} · {n.source}
              {n.evidence?.liveFetchedAt && <> · live-probed {new Date(n.evidence.liveFetchedAt).toLocaleDateString()}
                {n.evidence.hasAiOverview && <> · AI Overview: {n.evidence.tenantInAiOverview ? "✅ cited" : `❌ absent (${(n.evidence.competitorsCited ?? []).slice(0, 3).join(", ")})`}</>}
              </>}
            </div>
          </div>
        ))}
        {nodes.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-gray-400">No topics{filter ? ` with status ${filter}` : ""}.</div>}
      </div>
    </div>
  );
}
