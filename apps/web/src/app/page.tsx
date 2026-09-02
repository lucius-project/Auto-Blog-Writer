"use client";
import { useCallback, useEffect, useState } from "react";
import { WriteSchedulePanel } from "../components/WriteSchedulePanel";
import { BatchProgress } from "../components/BatchProgress";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Company = { id: string; name: string; url: string };
type Dashboard = {
  coveragePct: number;
  topics: { total: number; strong: number; weak: number; unanswered: number };
  posts: { awaitingReview: number; published: number };
  articleSpend?: { total: number; articles: number; avg: number };
  offPageTasks: { id: string; source: string; action: string }[];
  providerSpend: number;
};
export default function Home() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [dash, setDash] = useState<Record<string, Dashboard>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cs: Company[] = await fetch(`${API}/api/companies`).then((r) => r.json());
    setCompanies(cs);
    for (const c of cs) {
      fetch(`${API}/api/companies/${c.id}/dashboard`).then((r) => r.json())
        .then((d) => setDash((prev) => ({ ...prev, [c.id]: d })));
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const runWeekly = async (companyId: string) => {
    setRunning(companyId);
    await fetch(`${API}/api/jobs/weekly-run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    setNotice("Weekly cycle started — it re-crawls the site, runs live gap analysis and writes new articles. New drafts will appear in the review queue over the next 15–30 minutes.");
    setTimeout(() => setRunning(null), 4000);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div>
        <h1 className="text-3xl font-bold">Automated Blog Writer</h1>
        <p className="mt-1 text-gray-500">Answer coverage across every question your buyers ask an AI.</p>
      </div>
      {notice && (
        <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
          {notice} <button className="ml-2 underline" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}
      <AddCompany onAdded={load} onNotice={setNotice} />
      <div className="mt-8 space-y-6">
        {companies.map((c) => (
          <div key={`tools-${c.id}`} className="space-y-4">
            <WriteSchedulePanel companyId={c.id} onNotice={setNotice} />
            <BatchProgress companyId={c.id} />
          </div>
        ))}
        {companies.map((c) => {
          const d = dash[c.id];
          return (
            <div key={c.id} className="rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-semibold">{c.name}</div>
                  <div className="text-sm text-gray-400">{c.url}</div>
                </div>
                {d && (
                  <div className="text-right">
                    <div className="text-3xl font-bold">{d.coveragePct}%</div>
                    <div className="text-xs uppercase tracking-wide text-gray-400">answer coverage</div>
                  </div>
                )}
              </div>
              {d && (
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Topics" value={d.topics.total} />
                  <Stat label="Unanswered" value={d.topics.unanswered} />
                  <Stat label="Awaiting review" value={d.posts.awaitingReview} highlight={d.posts.awaitingReview > 0} />
                  <Stat label="Published" value={d.posts.published} />
                </div>
              )}
              {d?.articleSpend && d.articleSpend.articles > 0 && (
                <div className="mt-3 text-xs text-gray-500">
                  AI cost: <span className="font-mono text-gray-700">${d.articleSpend.total.toFixed(5)}</span> across {d.articleSpend.articles} articles
                  {" · "}<span className="font-mono text-gray-700">${d.articleSpend.avg.toFixed(5)}</span> avg per article
                  {" · "}<a href={`/company/${c.id}`} className="text-blue-600 underline">per-post breakdown →</a>
                </div>
              )}
              {d && d.offPageTasks.length > 0 && (
                <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  <b>Off-page targets:</b> {d.offPageTasks.map((t) => t.source).join(", ")}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <a href={`/review/${c.id}`} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
                  Open review queue{d && d.posts.awaitingReview ? ` (${d.posts.awaitingReview})` : ""}
                </a>
                <a href={`/company/${c.id}/calendar`} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium">
                  📅 Calendar
                </a>
                <a href={`/company/${c.id}`} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium">
                  Manage: posts, topics, settings
                </a>
                <button onClick={() => runWeekly(c.id)} disabled={running === c.id}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
                  {running === c.id ? "Starting…" : "Run weekly cycle now"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}

function AddCompany({ onAdded, onNotice }: { onAdded: () => void; onNotice: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name || !url) return;
    setBusy(true);
    const r = await fetch(`${API}/api/onboard`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, url: url.startsWith("http") ? url : `https://${url}` }),
    }).then((r) => r.json());
    setBusy(false);
    if (r.id) {
      onNotice(`${name} added. I'm crawling the site and researching the company now — next, open Manage → Settings to add locations, verticals, pricing and a testimonial book, then connect where blogs publish.`);
      setOpen(false); setName(""); setUrl("");
      onAdded();
    } else onNotice(`Failed: ${JSON.stringify(r)}`);
  };
  return (
    <div className="mt-6">
      {!open ? (
        <button onClick={() => setOpen(true)} className="rounded-lg border-2 border-dashed border-gray-300 px-5 py-3 text-sm font-medium text-gray-600 hover:border-gray-400">
          + Add company
        </button>
      ) : (
        <div className="rounded-xl border bg-white p-5">
          <div className="font-semibold">Add a company</div>
          <p className="mt-1 text-xs text-gray-500">Just the name and website — the system immediately crawls the site, audits AI-crawler access, builds the coverage map and researches the company profile.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">Company name<br />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme IT" className="mt-1 rounded border px-2 py-1" />
            </label>
            <label className="text-sm">Website<br />
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="acmeit.com" className="mt-1 w-64 rounded border px-2 py-1" />
            </label>
            <button disabled={busy} onClick={submit} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? "Adding…" : "Add & start research"}
            </button>
            <button onClick={() => setOpen(false)} className="px-2 py-2 text-sm text-gray-400">cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-blue-50" : "bg-gray-50"}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
