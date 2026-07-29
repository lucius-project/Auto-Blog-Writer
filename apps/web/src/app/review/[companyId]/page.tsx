"use client";
import { use, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Post = {
  id: string; title: string; slug: string; bodyHtml: string; status: string;
  scheduledFor: string | null;
  batch: { id: string; state: string } | null;
  seo: { metaTitle: string; metaDescription: string; targetQuestion?: string; faqs: { q: string; a: string }[] };
  qa: { pass: boolean; rewriteOf?: string | null; gates: { name: string; ok: boolean; required: boolean; detail?: string }[] } | null;
  location?: { city: string } | null;
  vertical?: { name: string } | null;
};

type Outcome = { postId: string; title: string; kind: "published" | "scheduled" | "rejected"; detail: string; href?: string };

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export default function Review({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [posts, setPosts] = useState<Post[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pickDate, setPickDate] = useState<Record<string, string>>({});
  const [showPicker, setShowPicker] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => fetch(`${API}/api/companies/${companyId}/review`).then((r) => r.json()).then(setPosts);
  useEffect(() => { load(); }, [companyId]);

  const approve = async (p: Post, when: "now" | "keep" | "at") => {
    setBusy(p.id); setError(null);
    const body: Record<string, unknown> = { when };
    if (when === "at") {
      const v = pickDate[p.id];
      if (!v) { setBusy(null); setError("Pick a date and time first."); return; }
      body.scheduledFor = new Date(v).toISOString();
    }
    const res = await fetch(`${API}/api/posts/${p.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(d.detail ?? d.error ?? `approve failed (${res.status})`); return; }
    setOutcomes((o) => [{
      postId: p.id, title: p.title,
      kind: d.action === "scheduled" ? "scheduled" : "published",
      detail: d.action === "scheduled"
        ? `Approved — pushed to the site's scheduler, goes live ${fmt(d.scheduledFor)}. Manage it under Posts & Schedule.`
        : `Approved — publishing right now. It will be live at /blog/${p.slug} within a few minutes.`,
      href: `/company/${companyId}`,
    }, ...o]);
    setShowPicker(null);
    load();
  };

  const reject = async (p: Post) => {
    setBusy(p.id); setError(null);
    await fetch(`${API}/api/posts/${p.id}/reject`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "rejected in review" }),
    });
    setBusy(null);
    setOutcomes((o) => [{ postId: p.id, title: p.title, kind: "rejected", detail: "Rejected — the topic goes back in the gap backlog for a future rewrite." }, ...o]);
    load();
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mt-2 text-2xl font-bold">Review queue</h1>
      <p className="mt-1 text-sm text-gray-500">
        Articles held for your judgment — batch leftovers (QA flags / near-duplicates), weekly drafts, and rewrites.
        Nothing here publishes until you approve it, and approving always shows you when it goes live.
      </p>

      {error && <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {outcomes.length > 0 && (
        <div className="mt-4 space-y-2">
          {outcomes.map((o) => (
            <div key={o.postId} className={`flex items-start justify-between gap-3 rounded-lg px-4 py-3 text-sm ${o.kind === "rejected" ? "bg-gray-100 text-gray-600" : "bg-green-50 text-green-800"}`}>
              <div>
                <span className="font-semibold">{o.kind === "rejected" ? "✕" : "✓"} {o.title}</span>
                <div className="mt-0.5">{o.detail}</div>
              </div>
              {o.href && <a href={o.href} className="shrink-0 text-xs font-medium underline">Posts & Schedule →</a>}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 space-y-4">
        {posts.map((p) => {
          const batchActive = p.batch && (p.batch.state === "running" || p.batch.state === "scheduling");
          const heldReason = p.qa && !p.qa.pass ? "QA flagged" : p.batch ? "held from batch (near-duplicate)" : p.qa?.rewriteOf ? "rewrite" : null;
          const hasFutureDate = p.scheduledFor && new Date(p.scheduledFor) > new Date();
          return (
            <div key={p.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold">{p.title}</div>
                  <div className="mt-1 text-xs text-gray-400">
                    /blog/{p.slug} · {p.vertical?.name ?? "general"} · {p.location?.city ?? "all locations"}
                  </div>
                  {p.seo?.targetQuestion && <div className="mt-1 text-xs text-gray-500">Fills gap: “{p.seo.targetQuestion}”</div>}
                  {hasFutureDate && (
                    <div className="mt-1 text-xs font-medium text-blue-700">
                      Reserved slot from your batch window: {fmt(p.scheduledFor)}
                    </div>
                  )}
                  {p.qa?.rewriteOf && <div className="mt-1 text-xs text-amber-600">Rewrite of the live article — approving updates the existing page in place.</div>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${p.qa?.pass ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    QA {p.qa?.pass ? "PASS" : "FAIL"}
                  </span>
                  {heldReason && <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">{heldReason}</span>}
                </div>
              </div>

              {p.qa && !p.qa.pass && (
                <div className="mt-2 text-xs text-red-600">
                  {p.qa.gates.filter((x) => !x.ok).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`).join(" · ")}
                </div>
              )}

              {batchActive ? (
                <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
                  This article's batch is still {p.batch!.state === "running" ? "writing" : "scheduling"} — it will get its date automatically when the batch finishes.
                  If it ends up held back, approve it here afterwards.
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button onClick={() => { setOpen(open === p.id ? null : p.id); setEditing(null); }} className="rounded-lg border px-3 py-1.5 text-sm">
                    {open === p.id ? "Hide preview" : "Preview"}
                  </button>
                  <button onClick={() => { setEditing(editing === p.id ? null : p.id); setOpen(null); }} className="rounded-lg border px-3 py-1.5 text-sm">
                    {editing === p.id ? "Close editor" : "Edit"}
                  </button>
                  {hasFutureDate && (
                    <button disabled={busy === p.id} onClick={() => approve(p, "keep")}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                      Approve — goes live {fmt(p.scheduledFor)}
                    </button>
                  )}
                  <button disabled={busy === p.id} onClick={() => approve(p, "now")}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${hasFutureDate ? "border border-green-600 text-green-700" : "bg-green-600 text-white"}`}>
                    {hasFutureDate ? "Publish now instead" : "Approve & publish now"}
                  </button>
                  <button onClick={() => setShowPicker(showPicker === p.id ? null : p.id)}
                    className="rounded-lg border border-green-600 px-3 py-1.5 text-sm font-medium text-green-700">
                    Pick date & time…
                  </button>
                  <button disabled={busy === p.id} onClick={() => reject(p)} className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50">
                    Reject
                  </button>
                </div>
              )}

              {showPicker === p.id && !batchActive && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-gray-50 px-4 py-3">
                  <input type="datetime-local" value={pickDate[p.id] ?? ""} onChange={(e) => setPickDate({ ...pickDate, [p.id]: e.target.value })}
                    className="rounded-lg border px-3 py-1.5 text-sm" />
                  <button disabled={busy === p.id} onClick={() => approve(p, "at")}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                    Approve for this date
                  </button>
                  <span className="text-xs text-gray-400">Pushed to the site scheduler immediately; goes live at the time you pick.</span>
                </div>
              )}

              {editing === p.id && <Editor post={p} onSaved={() => { setEditing(null); load(); }} />}

              {open === p.id && (
                <article className="prose prose-sm mt-4 max-w-none border-t pt-4" dangerouslySetInnerHTML={{ __html: `<h1>${p.title}</h1>` + p.bodyHtml }} />
              )}
            </div>
          );
        })}
        {posts.length === 0 && outcomes.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center text-gray-400">Nothing awaiting review.</div>
        )}
      </div>
    </main>
  );
}

/** In-place editing: title, meta, body HTML. Saving re-runs the QA gates. */
function Editor({ post, onSaved }: { post: Post; onSaved: () => void }) {
  const [title, setTitle] = useState(post.title);
  const [metaTitle, setMetaTitle] = useState(post.seo?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(post.seo?.metaDescription ?? "");
  const [bodyHtml, setBodyHtml] = useState(post.bodyHtml);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setResult(null);
    const res = await fetch(`${API}/api/posts/${post.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, metaTitle, metaDescription, bodyHtml }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setResult(`Save failed: ${d.error ?? res.status}`); return; }
    setResult(`Saved — QA now ${d.qa?.pass ? "PASSES" : `fails: ${d.qa?.gates?.filter((g: any) => !g.ok && g.required).map((g: any) => g.name).join(", ")}`}`);
    setTimeout(onSaved, 1200);
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-gray-50 p-4">
      <div>
        <label className="text-xs font-medium text-gray-600">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-gray-600">Meta title ({metaTitle.length}/60)</label>
          <input value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Meta description ({metaDescription.length}/155)</label>
          <input value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600">Body HTML</label>
        <textarea value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} rows={16}
          className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" />
      </div>
      {result && <div className={`rounded-lg px-3 py-2 text-sm ${result.startsWith("Saved") ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{result}</div>}
      <button disabled={busy} onClick={save} className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? "Saving…" : "Save & re-run QA"}
      </button>
    </div>
  );
}
