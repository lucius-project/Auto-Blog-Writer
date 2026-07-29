"use client";
import { use, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Task = {
  id: string; source: string; action: string; status: string; priority: number; evidence: any;
  draft: { format: string; subjectOrTitle: string; body: string; tips?: string[]; draftedAt: string } | null;
};

const STATUS_ORDER = ["open", "in_progress", "done", "dismissed"];
const STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", done: "Done", dismissed: "Dismissed" };

export default function OffPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafting, setDrafting] = useState<Set<string>>(new Set());
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/offpage`).then((r) => r.json()).then(setTasks), [companyId]);
  useEffect(() => { load(); }, [load]);
  // poll while any draft is generating
  useEffect(() => {
    if (!drafting.size) return;
    const t = setInterval(async () => {
      const fresh: Task[] = await fetch(`${API}/api/companies/${companyId}/offpage`).then((r) => r.json());
      setTasks(fresh);
      setDrafting((d) => new Set([...d].filter((id) => !fresh.find((x) => x.id === id)?.draft)));
    }, 4000);
    return () => clearInterval(t);
  }, [drafting.size, companyId]);

  const mark = async (id: string, status: string) => {
    await fetch(`${API}/api/offpage/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    load();
  };
  const draftIt = async (id: string) => {
    await fetch(`${API}/api/offpage/${id}/draft`, { method: "POST" });
    setDrafting((d) => new Set([...d, id]));
  };
  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id); setTimeout(() => setCopied(null), 1500);
  };

  const grouped = STATUS_ORDER.map((s) => ({ status: s, items: tasks.filter((t) => t.status === s) })).filter((g) => g.items.length);

  return (
    <div>
      <h1 className="text-2xl font-bold">Off-page tasks</h1>
      <p className="mt-1 text-sm text-gray-500">
        Sources AI engines cite for your buyers' prompts where this company has no presence. Blogs can't fix these —
        listings, reviews and mentions do. <span className="font-medium">Draft copy</span> writes the post/listing/email for you; you paste and submit it.
      </p>
      <div className="mt-4 space-y-6">
        {grouped.map((g) => (
          <div key={g.status}>
            <div className="text-xs font-semibold uppercase text-gray-400">{STATUS_LABEL[g.status]} ({g.items.length})</div>
            <div className="mt-2 space-y-2">
              {g.items.map((t) => (
                <div key={t.id} className="rounded-lg border bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold">{t.source}</div>
                    <div className="flex flex-wrap gap-2">
                      {!t.draft && !drafting.has(t.id) && t.status !== "dismissed" && (
                        <button onClick={() => draftIt(t.id)} className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white">Draft copy for me</button>
                      )}
                      {drafting.has(t.id) && <span className="rounded bg-gray-100 px-3 py-1 text-xs text-gray-500">Drafting…</span>}
                      {t.status !== "done" && <button onClick={() => mark(t.id, "done")} className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white">Done</button>}
                      {t.status === "open" && <button onClick={() => mark(t.id, "dismissed")} className="rounded bg-gray-100 px-3 py-1 text-xs">Dismiss</button>}
                      {t.status === "dismissed" && <button onClick={() => mark(t.id, "open")} className="rounded bg-gray-100 px-3 py-1 text-xs">Reopen</button>}
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{t.action}</p>
                  {t.evidence?.citedInProbes && <p className="mt-1 text-xs text-gray-400">Cited in {t.evidence.citedInProbes} live probe(s)</p>}
                  {t.draft && (
                    <div className="mt-3 rounded-lg bg-gray-50 p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-500">
                          {t.draft.format.replace(/_/g, " ")} · “{t.draft.subjectOrTitle}”
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setOpenDraft(openDraft === t.id ? null : t.id)} className="rounded border px-2 py-0.5 text-xs">
                            {openDraft === t.id ? "Hide" : "Show"}
                          </button>
                          <button onClick={() => copy(t.id, t.draft!.body)} className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white">
                            {copied === t.id ? "Copied ✓" : "Copy"}
                          </button>
                          <button onClick={() => draftIt(t.id)} className="rounded border px-2 py-0.5 text-xs">Redraft</button>
                        </div>
                      </div>
                      {openDraft === t.id && (
                        <>
                          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-gray-800">{t.draft.body}</pre>
                          {t.draft.tips?.length ? (
                            <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
                              {t.draft.tips.map((tip, i) => <li key={i}>{tip}</li>)}
                            </ul>
                          ) : null}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {tasks.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-gray-400">No off-page tasks yet. They appear as live probes find sources citing competitors.</div>}
      </div>
    </div>
  );
}
