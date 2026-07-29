"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

export function WriteSchedulePanel({ companyId, onNotice }: { companyId: string; onNotice: (m: string) => void }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [count, setCount] = useState("10");
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); });
  const [end, setEnd] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 31); return d.toISOString().slice(0, 10); });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/companies/${companyId}/topics?status=unanswered&take=200`).then((r) => r.json())
      .then((n) => setRemaining(Array.isArray(n) ? n.length : null));
  }, [companyId]);

  const run = async () => {
    setBusy(true);
    const r = await fetch(`${API}/api/companies/${companyId}/write-and-schedule`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: Number(count),
        start: new Date(start + "T08:00:00").toISOString(),
        end: new Date(end + "T17:00:00").toISOString(),
      }),
    }).then((r) => r.json());
    setBusy(false);
    onNotice(r.ok
      ? `Writing ${count} articles. QA-passing, non-duplicate articles will be auto-scheduled ${start} → ${end}, work hours 8am-5pm. Watch the progress bars below.`
      : `Failed: ${JSON.stringify(r)}`);
  };

  return (
    <div className="rounded-xl border-2 border-blue-200 bg-white p-5">
      <div className="font-semibold">Write & auto-schedule</div>
      <p className="mt-1 text-xs text-gray-500">
        Writes the top gap articles, QA-checks them, drops duplicates, then auto-schedules across your
        window — any day, 8am-5pm, randomized times 36-62+ minutes apart, released by the website's scheduler.
        {remaining != null && <> Currently <b>{remaining}</b> unanswered gaps available.</>}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">How many<br />
          <input type="number" min={1} max={150} value={count} onChange={(e) => setCount(e.target.value)} className="mt-1 w-24 rounded border px-2 py-1" />
        </label>
        <label className="text-sm">From<br />
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="mt-1 rounded border px-2 py-1" />
        </label>
        <label className="text-sm">Until<br />
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 rounded border px-2 py-1" />
        </label>
        <button disabled={busy} onClick={run} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Starting…" : "Write & auto-schedule"}
        </button>
      </div>
    </div>
  );
}
