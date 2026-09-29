"use client";
import { use, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Post = {
  id: string; title: string; slug: string; status: string;
  scheduledFor: string | null; publishedAt: string | null; publishedUrl: string | null;
  publishError: string | null;
  vertical?: { name: string } | null;
};

/** posted (live) / scheduled (on CMS scheduler, future) / review / failed */
function bucket(p: Post): "posted" | "scheduled" | "review" | "failed" | null {
  const when = p.publishedAt ?? p.scheduledFor;
  if (!when) return null;
  if (p.status === "failed") return "failed";
  if (["draft", "review"].includes(p.status)) return "review";
  if (p.status === "published" || p.status === "approved") {
    return new Date(when) <= new Date() ? "posted" : "scheduled";
  }
  return null;
}

const STYLE: Record<string, string> = {
  posted: "bg-green-100 text-green-800 border-green-200",
  scheduled: "bg-blue-100 text-blue-800 border-blue-200",
  review: "bg-amber-100 text-amber-800 border-amber-200",
  failed: "bg-red-100 text-red-700 border-red-200",
};
const LABEL: Record<string, string> = {
  posted: "posted", scheduled: "will post", review: "awaiting approval", failed: "failed",
};

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Industry icon: keyword match first, stable hash fallback so every vertical always gets the same icon. */
const ICON_RULES: [RegExp, string][] = [
  [/dent/i, "🦷"],
  [/health|medic|clinic|hospital|physician/i, "🏥"],
  [/construct|contractor|build/i, "🏗️"],
  [/cpa|account|bookkeep|tax/i, "🧮"],
  [/law|legal|attorney/i, "⚖️"],
  [/manufactur|industrial/i, "🏭"],
  [/financ|bank|invest|wealth/i, "💰"],
  [/real estate|property/i, "🏠"],
  [/restaurant|food|hospitality/i, "🍽️"],
  [/retail|shop|commerce/i, "🛍️"],
  [/school|educat|university/i, "🎓"],
  [/nonprofit|charity|church/i, "🤝"],
  [/tech|software|saas/i, "💻"],
  [/engineer/i, "📐"],
  [/insur/i, "🛡️"],
  [/veterinar|animal/i, "🐾"],
];
const FALLBACK_ICONS = ["🔷", "🔶", "🟢", "🟣", "⭐", "🔺", "🟤", "⬛"];
function industryIcon(name: string | null | undefined): string {
  if (!name) return "✏️";
  for (const [re, icon] of ICON_RULES) if (re.test(name)) return icon;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK_ICONS[h % FALLBACK_ICONS.length]!;
}

export default function CalendarPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [posts, setPosts] = useState<Post[]>([]);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [open, setOpen] = useState<Post | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  // a failed load (API restarting, error body) must not leave an empty-looking
  // calendar or crash the page — keep the last good posts and say so
  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/posts`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(data)) throw new Error(data?.error ?? `HTTP ${r.status}`);
        setPosts(data);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message || "network error")), [companyId]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  // month grid
  const first = new Date(month);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // start Monday
  const weeks: Date[][] = [];
  const cur = new Date(gridStart);
  do {
    const w: Date[] = [];
    for (let i = 0; i < 7; i++) { w.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(w);
  } while (cur.getMonth() === month.getMonth() || weeks.length < 4);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const byDay: Record<string, Post[]> = {};
  for (const p of posts) {
    const when = p.publishedAt ?? p.scheduledFor;
    if (!when || !bucket(p)) continue;
    const k = localKey(new Date(when));
    (byDay[k] ??= []).push(p);
  }
  for (const k of Object.keys(byDay)) byDay[k]!.sort((a, b) => new Date(a.publishedAt ?? a.scheduledFor!).getTime() - new Date(b.publishedAt ?? b.scheduledFor!).getTime());

  const today = localKey(new Date());
  const counts = { posted: 0, scheduled: 0, review: 0, failed: 0 } as Record<string, number>;
  for (const p of posts) { const b = bucket(p); if (b) counts[b]++; }

  const act = async (post: Post, action: "approve" | "retry") => {
    const url = action === "approve" ? `${API}/api/posts/${post.id}/approve` : `${API}/api/posts/${post.id}/retry-publish`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }).then((r) => r.json());
    setMsg(r.ok ? (r.action === "scheduled" ? `“${post.title.slice(0, 40)}” stays on schedule.` : `“${post.title.slice(0, 40)}” publishing now.`) : `Failed: ${r.detail ?? r.error}`);
    setOpen(null);
    load();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Calendar</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded-lg border px-3 py-1.5 text-sm">←</button>
          <div className="w-40 text-center text-sm font-semibold">{month.toLocaleString([], { month: "long", year: "numeric" })}</div>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded-lg border px-3 py-1.5 text-sm">→</button>
          <button onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }} className="rounded-lg border px-3 py-1.5 text-sm">Today</button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        {(["posted", "scheduled", "review", "failed"] as const).map((b) => (
          <span key={b} className={`rounded-full border px-2.5 py-0.5 font-medium ${STYLE[b]}`}>{counts[b]} {LABEL[b]}</span>
        ))}
        <span className="text-gray-300">|</span>
        {[...new Map(posts.filter((p) => bucket(p)).map((p) => [p.vertical?.name ?? "General", industryIcon(p.vertical?.name)])).entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, icon]) => (
            <span key={name} className="rounded-full border bg-white px-2.5 py-0.5 text-gray-600">{icon} {name}</span>
          ))}
      </div>

      {loadError && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn&apos;t load posts ({loadError}){posts.length ? " — showing the last loaded calendar" : ""}.{" "}
          <button className="ml-1 font-semibold underline" onClick={load}>Retry</button>
        </div>
      )}
      {msg && <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">{msg} <button className="ml-1 underline" onClick={() => setMsg(null)}>dismiss</button></div>}

      <div className="mt-4 overflow-hidden rounded-xl border bg-white">
        <div className="grid grid-cols-7 border-b bg-gray-50 text-center text-xs font-semibold uppercase text-gray-400">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="py-2">{d}</div>)}
        </div>
        {weeks.map((w, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b last:border-0">
            {w.map((d) => {
              const k = localKey(d);
              const inMonth = d.getMonth() === month.getMonth();
              const items = byDay[k] ?? [];
              return (
                <div key={k} className={`min-h-24 border-r p-1 last:border-0 ${inMonth ? "" : "bg-gray-50/60"} ${k === today ? "bg-blue-50/50" : ""}`}>
                  <div className={`px-1 text-xs ${k === today ? "font-bold text-blue-700" : inMonth ? "text-gray-500" : "text-gray-300"}`}>{d.getDate()}</div>
                  <div className="mt-0.5 space-y-0.5">
                    {items.map((p) => {
                      const b = bucket(p)!;
                      const when = p.publishedAt ?? p.scheduledFor!;
                      return (
                        <button key={p.id} onClick={() => setOpen(open?.id === p.id ? null : p)}
                          title={`${p.title} — ${LABEL[b]} ${fmtTime(when)}`}
                          className={`block w-full truncate rounded border px-1 py-0.5 text-left text-[11px] leading-tight ${STYLE[b]}`}>
                          {industryIcon(p.vertical?.name)} {fmtTime(when)} {p.title}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-2xl rounded-t-2xl border bg-white p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">{open.title}</div>
              <div className="mt-1 text-xs text-gray-500">
                <span className={`mr-2 rounded-full border px-2 py-0.5 font-medium ${STYLE[bucket(open)!]}`}>{LABEL[bucket(open)!]}</span>
                {new Date(open.publishedAt ?? open.scheduledFor!).toLocaleString()} · {industryIcon(open.vertical?.name)} {open.vertical?.name ?? "general"} · /blog/{open.slug}
              </div>
              {open.publishError && <div className="mt-1 text-xs text-red-600">{open.publishError.slice(0, 160)}</div>}
            </div>
            <button onClick={() => setOpen(null)} className="rounded-lg border px-2 py-1 text-sm">✕</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {bucket(open) === "review" && (
              <>
                <a href={`/review/${companyId}`} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white">Open in review queue</a>
              </>
            )}
            {bucket(open) === "failed" && (
              <button onClick={() => act(open, "retry")} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white">Retry publish</button>
            )}
            {open.publishedUrl && bucket(open) === "posted" && (
              <a href={open.publishedUrl} target="_blank" className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white">View live ↗</a>
            )}
            <a href={`/company/${companyId}`} className="rounded-lg border px-3 py-1.5 text-sm">Manage in Posts</a>
          </div>
        </div>
      )}
    </div>
  );
}
