"use client";
import { use, useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type PageRow = {
  url: string; path: string; contentType: string | null; title: string | null;
  primaryTopic: string | null; wordCount: number | null; hasSchema: boolean;
  inboundInternal: number; isPillar: boolean; outboundInternal: number; outboundExternal: number; orphan: boolean;
};
type Pillar = PageRow & {
  linkedFrom: { path: string; title: string | null; anchor: string }[];
  missingLinks: { path: string; title: string | null; contentType: string | null }[];
};
type SiteMap = {
  lastCrawledAt: string | null;
  brokenLinkCount: number;
  stats: { total: number; pillars: number; orphans: number; noInboundPct: number };
  pillars: Pillar[];
  orphans: PageRow[];
  pages: PageRow[];
};
type Broken = {
  targetUrl: string; status: number | null; kind: string; error: string | null; checkedAt: string;
  sources: { sourceUrl: string; sourcePath: string; anchor: string }[];
  fixable: boolean; inPosts: { id: string; title: string }[];
};

const TYPE_CHIP: Record<string, string> = {
  home: "bg-purple-100 text-purple-700", service: "bg-blue-100 text-blue-700",
  industry: "bg-teal-100 text-teal-700", location: "bg-amber-100 text-amber-700",
  blog: "bg-gray-100 text-gray-600", landing: "bg-green-100 text-green-700",
  legal: "bg-gray-100 text-gray-400", other: "bg-gray-100 text-gray-500",
};
const rel = (iso: string | null) => {
  if (!iso) return "never";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 3600e3) return `${Math.round(d / 60e3)}m ago`;
  if (d < 864e5) return `${Math.round(d / 3600e3)}h ago`;
  if (d < 2 * 864e5) return "yesterday";
  return `${Math.round(d / 864e5)}d ago`;
};

export default function SiteMapPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [data, setData] = useState<SiteMap | null>(null);
  const [broken, setBroken] = useState<Broken[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    fetch(`${API}/api/companies/${companyId}/site-map`).then((r) => r.json()).then(setData).catch(() => {});
    fetch(`${API}/api/companies/${companyId}/broken-links`).then((r) => r.json()).then(setBroken).catch(() => {});
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const recheck = async () => {
    setBusy(true);
    await fetch(`${API}/api/companies/${companyId}/site-map/recheck`, { method: "POST" });
    setBusy(false);
    setNote("Re-crawling the site and re-checking every link — this takes a few minutes. Reload when it's done.");
  };
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const fixableCount = broken.filter((b) => b.fixable).length;
  const fixInPosts = async () => {
    setBusy(true);
    const r = await fetch(`${API}/api/companies/${companyId}/broken-links/fix`, { method: "POST" }).then((x) => x.json());
    setBusy(false);
    setNote(`Fixed ${r.linksFixed} link${r.linksFixed === 1 ? "" : "s"} (repointed) + ${r.linksUnwrapped} unwrapped across ${r.postsFixed} post${r.postsFixed === 1 ? "" : "s"}. Published posts are back in the review queue — approve them to push the corrected version live, then re-crawl to clear these.`);
    setTimeout(load, 2000);
  };
  const exportCsv = () => {
    const rows = [["Target URL", "Status", "Type", "Anchor text", "Source page URL", "Source path", "In blog post"]];
    for (const b of broken) for (const s of (b.sources.length ? b.sources : [{ sourceUrl: "", sourcePath: "", anchor: "" }])) {
      rows.push([b.targetUrl, String(b.status ?? b.error ?? "failed"), b.kind, s.anchor, s.sourceUrl, s.sourcePath, b.inPosts.map((p) => p.title).join("; ")]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `broken-links-${companyId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };
  const copyForDev = async () => {
    const lines = broken.map((b) =>
      `- [${b.status ?? "FAIL"}] ${b.targetUrl}\n  from: ${b.sources.slice(0, 5).map((s) => `${s.sourcePath}${s.anchor ? ` ("${s.anchor}")` : ""}`).join(", ")}`);
    await navigator.clipboard.writeText(`# Broken links — ${new Date().toLocaleDateString()}\n\n${lines.join("\n")}`);
    setNote(`Copied ${broken.length} broken links to clipboard (markdown).`);
  };

  if (!data) return <div className="py-12 text-center text-gray-400">Loading…</div>;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Site map</h1>
          <p className="mt-1 text-sm text-gray-500">
            Internal link structure, pillar pages and their supporting clusters, orphaned pages, and broken links.
            {data.lastCrawledAt && <> Crawled {rel(data.lastCrawledAt)}.</>}
          </p>
        </div>
        <button onClick={recheck} disabled={busy} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Starting…" : "Re-crawl & re-check links"}
        </button>
      </div>
      {note && <div className="mt-3 rounded bg-blue-50 p-2 text-sm text-blue-900">{note}</div>}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile n={data.stats.total} label="Pages crawled" />
        <Tile n={data.stats.pillars} label="Pillar pages" />
        <Tile n={data.stats.orphans} label="Orphan pages" tone={data.stats.orphans > 0 ? "amber" : undefined} />
        <Tile n={data.brokenLinkCount} label="Broken links" tone={data.brokenLinkCount > 0 ? "red" : undefined} />
      </div>

      {/* broken links */}
      {broken.length > 0 && (
        <div className="mt-6 rounded-xl border border-red-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-red-700">Broken links ({broken.length})</div>
            <div className="flex flex-wrap gap-2">
              {fixableCount > 0 && (
                <button onClick={fixInPosts} disabled={busy} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  {busy ? "Fixing…" : `Fix ${fixableCount} in blog posts`}
                </button>
              )}
              <button onClick={exportCsv} className="rounded-lg border px-3 py-1.5 text-xs font-medium">Export CSV</button>
              <button onClick={copyForDev} className="rounded-lg border px-3 py-1.5 text-xs font-medium">Copy for developer</button>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            “Fix in blog posts” repoints broken internal links inside your generated articles to the closest real page
            (or unwraps them), then sends those posts to the review queue to push live. Links inside your own site
            pages need a developer — use Export / Copy for those.
          </p>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-gray-400">
              <th className="py-1">Target</th><th>Status</th><th>Type</th><th>Linked from</th>
            </tr></thead>
            <tbody>
              {broken.map((b) => (
                <tr key={b.targetUrl} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <span className="break-all">{b.targetUrl}</span>
                    {b.fixable && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">auto-fixable</span>}
                  </td>
                  <td className="py-2 pr-3"><span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">{b.status ?? b.error?.slice(0, 24) ?? "failed"}</span></td>
                  <td className="py-2 pr-3 text-xs text-gray-500">{b.kind}</td>
                  <td className="py-2 text-xs text-gray-600">
                    {b.sources.slice(0, 4).map((s, i) => (
                      <div key={i}><a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{s.sourcePath}</a>{s.anchor ? ` — “${s.anchor}”` : ""}</div>
                    ))}
                    {b.sources.length > 4 && <div className="text-gray-400">+{b.sources.length - 4} more</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {broken.length === 0 && (
        <div className="mt-6 rounded-xl border bg-white p-4 text-sm text-green-700">✓ No broken links found on the last crawl.</div>
      )}

      {/* pillar pages */}
      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="text-sm font-semibold">Pillar pages &amp; their clusters</div>
        <p className="mt-1 text-xs text-gray-500">Hub pages (home / service / industry with ≥3 internal inbound links). Each should be linked from every related page. “Should link here” = same-topic pages that don’t yet.</p>
        <div className="mt-3 space-y-2">
          {data.pillars.map((p) => (
            <div key={p.path} className="rounded-lg border bg-gray-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TYPE_CHIP[p.contentType ?? "other"] ?? ""}`}>{p.contentType}</span>
                <a href={p.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-blue-600 hover:underline">{p.title ?? p.path}</a>
                <span className="text-xs text-gray-400">{p.path}</span>
                <span className="ml-auto text-xs font-medium text-gray-600">{p.inboundInternal} link{p.inboundInternal === 1 ? "" : "s"} in</span>
                {p.missingLinks.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">{p.missingLinks.length} missing</span>}
              </div>
              <div className="mt-2 flex gap-4 text-xs">
                <button onClick={() => toggle(`in-${p.path}`)} className="text-blue-600">
                  {open.has(`in-${p.path}`) ? "▾" : "▸"} linked from ({p.linkedFrom.length})
                </button>
                {p.missingLinks.length > 0 && (
                  <button onClick={() => toggle(`miss-${p.path}`)} className="text-amber-700">
                    {open.has(`miss-${p.path}`) ? "▾" : "▸"} should link here ({p.missingLinks.length})
                  </button>
                )}
              </div>
              {open.has(`in-${p.path}`) && (
                <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                  {p.linkedFrom.map((s, i) => <li key={i}>← {s.title ?? s.path} <span className="text-gray-400">{s.anchor ? `“${s.anchor}”` : s.path}</span></li>)}
                  {p.linkedFrom.length === 0 && <li className="text-red-600">nothing links here — add links from related pages</li>}
                </ul>
              )}
              {open.has(`miss-${p.path}`) && (
                <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
                  {p.missingLinks.map((s, i) => <li key={i}>+ add a link from <b>{s.title ?? s.path}</b> <span className="text-amber-600">({s.contentType})</span></li>)}
                </ul>
              )}
            </div>
          ))}
          {data.pillars.length === 0 && <div className="text-sm text-gray-400">No pillar pages detected yet — run a re-crawl.</div>}
        </div>
      </div>

      {/* orphans */}
      {data.orphans.length > 0 && (
        <div className="mt-6 rounded-xl border bg-white p-5">
          <div className="text-sm font-semibold">Orphan pages ({data.orphans.length})</div>
          <p className="mt-1 text-xs text-gray-500">No other page on the site links to these internally — search engines and visitors can barely find them. Add contextual links from relevant pages.</p>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-gray-400"><th className="py-1">Page</th><th>Type</th><th>Words</th></tr></thead>
            <tbody>
              {data.orphans.map((p) => (
                <tr key={p.path} className="border-b">
                  <td className="py-1.5 pr-3"><a href={p.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{p.title ?? p.path}</a> <span className="text-xs text-gray-400">{p.path}</span></td>
                  <td className="py-1.5 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${TYPE_CHIP[p.contentType ?? "other"] ?? ""}`}>{p.contentType}</span></td>
                  <td className="py-1.5 text-xs text-gray-500">{p.wordCount ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* all pages */}
      <div className="mt-6 rounded-xl border bg-white p-5">
        <button onClick={() => setShowAll((v) => !v)} className="text-sm font-semibold text-blue-600">
          {showAll ? "▾ Hide" : "▸ Show"} all {data.pages.length} pages &amp; link counts
        </button>
        {showAll && (
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-gray-400">
              <th className="py-1">Page</th><th>Type</th><th className="text-right">In</th><th className="text-right">Out (int)</th><th className="text-right">Out (ext)</th><th>Schema</th>
            </tr></thead>
            <tbody>
              {data.pages.map((p) => (
                <tr key={p.path} className={`border-b ${p.orphan ? "bg-amber-50/40" : ""}`}>
                  <td className="py-1.5 pr-3"><a href={p.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{p.path}</a>{p.isPillar && <span className="ml-1 text-[10px] text-purple-600">★pillar</span>}</td>
                  <td className="py-1.5 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${TYPE_CHIP[p.contentType ?? "other"] ?? ""}`}>{p.contentType}</span></td>
                  <td className={`py-1.5 text-right ${p.inboundInternal === 0 ? "font-medium text-amber-600" : ""}`}>{p.inboundInternal}</td>
                  <td className="py-1.5 text-right text-gray-500">{p.outboundInternal}</td>
                  <td className="py-1.5 text-right text-gray-500">{p.outboundExternal}</td>
                  <td className="py-1.5 text-xs">{p.hasSchema ? "✓" : <span className="text-gray-300">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone?: "amber" | "red" }) {
  const c = tone === "amber" ? "border-amber-300 bg-amber-50" : tone === "red" ? "border-red-300 bg-red-50" : "border-gray-200 bg-white";
  return (
    <div className={`rounded-xl border p-4 ${c}`}>
      <div className="text-2xl font-bold">{n}</div>
      <div className="text-sm font-medium text-gray-700">{label}</div>
    </div>
  );
}
