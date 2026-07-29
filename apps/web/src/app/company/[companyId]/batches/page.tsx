"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Post = { id: string; title: string; status: string; scheduledFor: string | null; publishedUrl: string | null };
type Run = {
  id: string; state: string; total: number; written: number; scheduled: number;
  skippedQa: number; skippedDup: number; failed: number;
  startedAt: string; finishedAt: string | null; posts: Post[];
};

export default function Batches({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${API}/api/companies/${companyId}/batches`).then((r) => r.json()).then(setRuns);
  }, [companyId]);
  return (
    <div>
      <h1 className="text-2xl font-bold">Batch history</h1>
      <p className="mt-1 text-sm text-gray-500">Every write & auto-schedule run, with the articles it produced.</p>
      <div className="mt-4 space-y-3">
        {runs.map((r) => (
          <div key={r.id} className="rounded-xl border bg-white p-4">
            <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center justify-between text-left">
              <div>
                <span className="font-semibold">{new Date(r.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className={`ml-3 rounded-full px-2 py-0.5 text-xs font-medium ${r.state === "done" ? "bg-green-100 text-green-700" : r.state === "running" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{r.state}</span>
              </div>
              <div className="text-sm text-gray-500">{r.written}/{r.total} written · {r.scheduled} scheduled</div>
            </button>
            {open === r.id && (
              <div className="mt-3 divide-y rounded-lg border">
                {r.posts.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="truncate">{p.publishedUrl ? <a className="text-blue-600" href={p.publishedUrl} target="_blank">{p.title}</a> : p.title}</span>
                    <span className="shrink-0 text-xs text-gray-500">
                      {p.status === "published" && p.scheduledFor ? `→ ${new Date(p.scheduledFor).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : p.status === "draft" ? "in review" : p.status}
                    </span>
                  </div>
                ))}
                {r.posts.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No articles recorded for this run.</div>}
              </div>
            )}
          </div>
        ))}
        {runs.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center text-gray-400">No batches yet.</div>}
      </div>
    </div>
  );
}
