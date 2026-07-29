"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Run = {
  id?: string; state: string; total?: number; written?: number; scheduled?: number;
  skippedQa?: number; skippedDup?: number; failed?: number;
  currentTitle?: string | null; currentStep?: string | null;
  startedAt?: string; finishedAt?: string | null;
};
type BatchPost = { id: string; title: string; status: string; scheduledFor: string | null; publishedUrl: string | null };

const STEPS = ["grounding", "drafting", "self-critique", "qa-gates", "repair-1", "repair-2", "saving", "done"];
const STEP_LABEL: Record<string, string> = {
  starting: "Starting", grounding: "Researching & grounding", drafting: "Writing draft",
  "self-critique": "Editor critique", "qa-gates": "QA gates", "repair-1": "Auto-repair (1)",
  "repair-2": "Auto-repair (2)", saving: "Saving", done: "Done", failed: "Failed", scheduling: "Scheduling batch",
};

export function BatchProgress({ companyId }: { companyId: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [posts, setPosts] = useState<BatchPost[]>([]);
  useEffect(() => {
    const poll = () => fetch(`${API}/api/companies/${companyId}/batch`).then((r) => r.json()).then(setRun).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [companyId]);

  useEffect(() => {
    if (!run || run.state === "running") return;
    fetch(`${API}/api/companies/${companyId}/batches`).then((r) => r.json())
      .then((runs) => { const mine = runs.find((x: any) => x.id === run.id); setPosts(mine?.posts ?? []); })
      .catch(() => {});
  }, [companyId, run?.state, run?.id]);

  if (!run || run.state === "none") return null;
  const total = run.total ?? 0;
  const done = (run.written ?? 0) + (run.failed ?? 0);
  const overallPct = total ? Math.round((done / total) * 100) : 0;
  const active = run.state === "running" || run.state === "scheduling";
  // hide finished runs after a while
  if (!active && run.finishedAt && Date.now() - new Date(run.finishedAt).getTime() > 30 * 60e3) return null;

  const stepIdx = STEPS.indexOf(run.currentStep ?? "");
  const stepPct = run.currentStep === "done" ? 100 : Math.max(5, Math.round(((stepIdx + 1) / STEPS.length) * 100));

  return (
    <div className="rounded-xl border bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="font-semibold">
          {run.state === "running" && "Writing batch…"}
          {run.state === "scheduling" && "Scheduling batch…"}
          {run.state === "done" && "Batch complete"}
          {run.state === "failed" && "Batch failed"}
        </div>
        <div className="text-sm text-gray-500">{done} / {total} articles</div>
      </div>

      {/* overall bar */}
      <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-blue-600 transition-all duration-700" style={{ width: `${overallPct}%` }} />
      </div>

      {/* current article + step bar */}
      {active && run.state === "running" && (
        <div className="mt-4 rounded-lg bg-gray-50 p-3">
          <div className="text-sm font-medium">{run.currentTitle ?? "…"}</div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div className={`h-full rounded-full transition-all duration-500 ${run.currentStep === "failed" ? "bg-red-500" : "bg-green-500"}`} style={{ width: `${stepPct}%` }} />
          </div>
          <div className="mt-1 text-xs text-gray-500">{STEP_LABEL[run.currentStep ?? ""] ?? run.currentStep ?? ""}</div>
        </div>
      )}

      {(run.state === "done" || run.state === "scheduling" || run.state === "stopped") && (
        <div className="mt-3 text-sm text-gray-600">
          {run.state === "stopped" ? "Batch stopped — written articles are in the review queue. " : ""}
          {run.scheduled ?? 0} scheduled · {run.skippedQa ?? 0} QA-failed → review · {run.skippedDup ?? 0} duplicates → review · {run.failed ?? 0} errored
        </div>
      )}

      {posts.length > 0 && run.state !== "running" && (
        <div className="mt-3 divide-y rounded-lg border">
          {posts.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate">{p.title}</span>
              <span className="shrink-0 text-xs text-gray-500">
                {p.status === "published" && p.scheduledFor ? `→ ${new Date(p.scheduledFor).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                  : p.status === "draft" ? "in review queue" : p.status}
              </span>
            </div>
          ))}
        </div>
      )}
      <a href={`/company/${companyId}/batches`} className="mt-3 inline-block text-xs text-blue-600">View batch history →</a>
    </div>
  );
}
