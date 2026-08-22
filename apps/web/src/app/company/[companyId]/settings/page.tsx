"use client";
import { use, useCallback, useEffect, useState } from "react";
import { WriteSchedulePanel } from "../../../../components/WriteSchedulePanel";
import { BatchProgress } from "../../../../components/BatchProgress";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

export default function Settings({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = use(params);
  const [company, setCompany] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/full`).then((r) => r.json()).then(setCompany), [companyId]);
  useEffect(() => { load(); }, [load]);

  const settings = { weeklyCapPerPair: 5, weeklyCapTotal: 10, autoApprove: false, killSwitch: false, ...(company?.settings ?? {}) };

  const patch = async (upd: Record<string, unknown>) => {
    await fetch(`${API}/api/companies/${companyId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(upd),
    });
    load();
  };

  const action = async (label: string, fn: () => Promise<Response>) => {
    setBusy(label);
    const r = await (await fn()).json();
    setMsg(r.queued ? `Queued: ${r.queued.join(" · ")}` : `${label} started.`);
    setBusy(null);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">Settings & actions</h1>
      {msg && <div className="mt-3 rounded bg-blue-50 p-2 text-sm text-blue-900">{msg} <button className="underline" onClick={() => setMsg(null)}>dismiss</button></div>}

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="font-semibold">Run the engine</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={!!busy} onClick={() => action("Gap check", () =>
            fetch(`${API}/api/companies/${companyId}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ liveProbeCount: 12 }) }))}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Check for gaps now
          </button>
          <button disabled={!!busy} onClick={() => action("Graph expansion + gap check", () =>
            fetch(`${API}/api/companies/${companyId}/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ liveProbeCount: 12, expandPerPair: 100 }) }))}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Expand topic graph (+100/vertical) & check gaps
          </button>
          <button disabled={!!busy} onClick={() => action("Write next blog", () =>
            fetch(`${API}/api/companies/${companyId}/generate-next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 1 }) }))}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Write next blog (to review queue)
          </button>
          <button disabled={!!busy} onClick={() => action("Rewrite weak answers", () =>
            fetch(`${API}/api/companies/${companyId}/rewrite-weak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 5 }) }))}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Rewrite 5 weakest answers (in place)
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">Gap checks pull live SERP/AI-Overview evidence. Written articles land in the review queue (~2-3 min each).</p>
      </div>

      <div className="mt-6"><WriteSchedulePanel companyId={companyId} onNotice={setMsg} /></div>
      <div className="mt-4"><BatchProgress companyId={companyId} /></div>

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="font-semibold">Guardrails</div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">Weekly cap per location×vertical
            <input type="number" min={1} max={30} defaultValue={settings.weeklyCapPerPair} key={`p${settings.weeklyCapPerPair}`}
              onBlur={(e) => patch({ weeklyCapPerPair: Number(e.target.value) })}
              className="mt-1 block w-28 rounded border px-2 py-1" />
          </label>
          <label className="text-sm">Weekly cap total
            <input type="number" min={1} max={60} defaultValue={settings.weeklyCapTotal} key={`t${settings.weeklyCapTotal}`}
              onBlur={(e) => patch({ weeklyCapTotal: Number(e.target.value) })}
              className="mt-1 block w-28 rounded border px-2 py-1" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.autoApprove} onChange={(e) => patch({ autoApprove: e.target.checked })} />
            Auto-approve QA-passing posts (skip review queue)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.killSwitch} onChange={(e) => patch({ killSwitch: e.target.checked })} />
            <span className="font-medium text-red-700">Kill switch (pause all automated runs)</span>
          </label>
          <label className="text-sm sm:col-span-2">Notification webhook (optional — Slack/Teams incoming-webhook URL; batch results, publish failures and weekly runs post there)
            <input type="url" placeholder="https://hooks.slack.com/services/…" defaultValue={(settings as any).notifyWebhookUrl ?? ""} key={`w${(settings as any).notifyWebhookUrl ?? ""}`}
              onBlur={(e) => patch({ notifyWebhookUrl: e.target.value || null })}
              className="mt-1 block w-full rounded border px-2 py-1" />
          </label>
        </div>
        <p className="mt-3 text-xs text-gray-500">Raise caps gradually as published posts prove indexation — a sudden 0→dozens/day jump is the pattern Google's scaled-content enforcement targets.</p>
      </div>

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="font-semibold">Pricing ranges</div>
        <p className="mt-1 text-xs text-gray-500">
          The writer uses ONLY these ranges for any pricing claim — always presented as the full range,
          never a made-up exact number. Leave empty and articles will use a flagged placeholder instead.
        </p>
        <PricingTable companyId={companyId} />
      </div>

      <div className="mt-6 rounded-xl border bg-white p-5">
        <div className="font-semibold">Testimonial book & grounding documents</div>
        <p className="mt-1 text-xs text-gray-500">
          Upload your testimonial book (PDF). Every testimonial is extracted and stored individually with
          industry/keyword tags — each article then automatically pulls only the 3–4 most relevant real
          examples (matched by vertical and topic, no AI search) so blogs carry genuine social proof.
        </p>
        <DocumentUpload companyId={companyId} />
      </div>

      <LocationsManager company={company} reload={load} onNotice={setMsg} />
      <PublishTargets company={company} reload={load} onNotice={setMsg} companyId={companyId} />
      <Automation companyId={companyId} onNotice={setMsg} />
    </div>
  );
}


function DocumentUpload({ companyId }: { companyId: string }) {
  const [docs, setDocs] = useState<{ documents: any[]; testimonialCount: number }>({ documents: [], testimonialCount: 0 });
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/documents`).then((r) => r.json()).then(setDocs), [companyId]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`${API}/api/companies/${companyId}/documents`, { method: "POST", body: fd });
    setUploading(false);
    load();
  };

  const remove = async (d: any) => {
    setRemoving(d.id);
    try {
      await fetch(`${API}/api/companies/${companyId}/documents/${d.id}`, { method: "DELETE" });
    } finally {
      setRemoving(null);
      load();
    }
  };

  return (
    <div className="mt-3">
      <label className="inline-block cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
        {uploading ? "Uploading…" : "Upload testimonial book (PDF)"}
        <input type="file" accept=".pdf,.txt,.md" className="hidden"
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} disabled={uploading} />
      </label>
      <span className="ml-3 text-sm text-gray-600">{docs.testimonialCount} testimonials extracted and searchable</span>
      <div className="mt-3 space-y-1 text-sm">
        {docs.documents.map((d) => (
          <div key={d.id} className="flex items-center gap-2">
            <span className="font-medium">{d.filename}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${d.status === "ready" ? "bg-green-100 text-green-700" : d.status === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
              {d.status === "extracting" ? "extracting…" : d.status}
            </span>
            {d.error && <span className="text-xs text-red-600">{d.error}</span>}
            <button onClick={() => remove(d)} disabled={removing === d.id}
              className="text-xs text-red-600 hover:underline disabled:opacity-50">
              {removing === d.id ? "removing…" : "remove"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


function PricingTable({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [draft, setDraft] = useState({ service: "", unit: "per user/month", low: "", high: "", notes: "" });
  const load = useCallback(() =>
    fetch(`${API}/api/companies/${companyId}/pricing`).then((r) => r.json()).then(setRows), [companyId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!draft.service || !draft.low || !draft.high) return;
    await fetch(`${API}/api/companies/${companyId}/pricing`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, low: Number(draft.low), high: Number(draft.high), notes: draft.notes || null }),
    });
    setDraft({ service: "", unit: "per user/month", low: "", high: "", notes: "" });
    load();
  };
  const patch = async (id: string, field: string, value: string) => {
    const body: any = {};
    body[field] = field === "low" || field === "high" ? Number(value) : value;
    await fetch(`${API}/api/pricing/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    load();
  };
  const remove = async (id: string) => { await fetch(`${API}/api/pricing/${id}`, { method: "DELETE" }); load(); };

  const UNITS = ["per user/month", "per device/month", "flat monthly", "per hour", "one-time project"];
  return (
    <div className="mt-3">
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-xs uppercase text-gray-400">
          <th className="py-1">Service</th><th>Low $</th><th>High $</th><th>Unit</th><th>Notes</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b">
              <td className="py-1 pr-2"><input defaultValue={r.service} onBlur={(e) => patch(r.id, "service", e.target.value)} className="w-full rounded border px-2 py-1" /></td>
              <td className="pr-2"><input type="number" defaultValue={r.low} onBlur={(e) => patch(r.id, "low", e.target.value)} className="w-20 rounded border px-2 py-1" /></td>
              <td className="pr-2"><input type="number" defaultValue={r.high} onBlur={(e) => patch(r.id, "high", e.target.value)} className="w-20 rounded border px-2 py-1" /></td>
              <td className="pr-2">
                <select defaultValue={r.unit} onBlur={(e) => patch(r.id, "unit", e.target.value)} className="rounded border px-2 py-1">
                  {UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </td>
              <td className="pr-2"><input defaultValue={r.notes ?? ""} onBlur={(e) => patch(r.id, "notes", e.target.value)} className="w-full rounded border px-2 py-1" /></td>
              <td><button onClick={() => remove(r.id)} className="text-xs text-red-600">remove</button></td>
            </tr>
          ))}
          <tr>
            <td className="py-2 pr-2"><input placeholder="e.g. Managed IT Services" value={draft.service} onChange={(e) => setDraft({ ...draft, service: e.target.value })} className="w-full rounded border px-2 py-1" /></td>
            <td className="pr-2"><input type="number" placeholder="100" value={draft.low} onChange={(e) => setDraft({ ...draft, low: e.target.value })} className="w-20 rounded border px-2 py-1" /></td>
            <td className="pr-2"><input type="number" placeholder="200" value={draft.high} onChange={(e) => setDraft({ ...draft, high: e.target.value })} className="w-20 rounded border px-2 py-1" /></td>
            <td className="pr-2">
              <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} className="rounded border px-2 py-1">
                {UNITS.map((u) => <option key={u}>{u}</option>)}
              </select>
            </td>
            <td className="pr-2"><input placeholder="optional context" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className="w-full rounded border px-2 py-1" /></td>
            <td><button onClick={add} className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white">Add</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}




const COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
];

// Regulations/compliance frameworks are looked up per-country in the worker
// (apps/worker/src/lib/taxonomy.ts) — only US and CA are supported there today.
const STATES_BY_COUNTRY: Record<string, { code: string; name: string }[]> = {
  US: [
    { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
    { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
    { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "DC", name: "District of Columbia" },
    { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" },
    { code: "ID", name: "Idaho" }, { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
    { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" },
    { code: "LA", name: "Louisiana" }, { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
    { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" },
    { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
    { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" },
    { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
    { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" },
    { code: "OK", name: "Oklahoma" }, { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
    { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" },
    { code: "TN", name: "Tennessee" }, { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
    { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" },
    { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
  ],
  CA: [
    { code: "AB", name: "Alberta" }, { code: "BC", name: "British Columbia" }, { code: "MB", name: "Manitoba" },
    { code: "NB", name: "New Brunswick" }, { code: "NL", name: "Newfoundland and Labrador" },
    { code: "NS", name: "Nova Scotia" }, { code: "NT", name: "Northwest Territories" }, { code: "NU", name: "Nunavut" },
    { code: "ON", name: "Ontario" }, { code: "PE", name: "Prince Edward Island" }, { code: "QC", name: "Quebec" },
    { code: "SK", name: "Saskatchewan" }, { code: "YT", name: "Yukon" },
  ],
};

function LocationsManager({ company, reload, onNotice }: { company: any; reload: () => void; onNotice: (m: string) => void }) {
  const [loc, setLoc] = useState({ name: "", city: "", state: "", country: "CA" });
  const [vertDraft, setVertDraft] = useState<Record<string, string>>({});
  const [researching, setResearching] = useState(false);
  const unprofiled = (company?.locations ?? []).flatMap((l: any) => l.verticals).filter((v: any) => !v.profile).length;
  // live-poll while research is running so the ✓ appears without a manual refresh
  useEffect(() => {
    if (!researching) return;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [researching]);
  useEffect(() => {
    if (researching && unprofiled === 0) {
      setResearching(false);
      onNotice("✓ Research finished — every vertical now has its profile. New topic questions are appearing under Topics.");
    }
  }, [researching, unprofiled]);
  if (!company) return null;

  const addLocation = async () => {
    if (!loc.city) return;
    await fetch(`${API}/api/companies/${company.id}/locations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: loc.name || `${loc.city} office`, city: loc.city, state: loc.state || undefined, country: loc.country }),
    });
    setLoc({ name: "", city: "", state: "", country: "CA" });
    reload();
    onNotice("Location added. Add its verticals, then click 'Research new additions' so profiles and topics get built for it.");
  };
  const addVertical = async (locationId: string) => {
    const name = vertDraft[locationId];
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await fetch(`${API}/api/companies/${company.id}/locations/${locationId}/verticals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug }),
    });
    setVertDraft((d) => ({ ...d, [locationId]: "" }));
    reload();
  };
  const removeVertical = async (id: string) => { await fetch(`${API}/api/verticals/${id}`, { method: "DELETE" }); reload(); };
  const removeLocation = async (id: string) => { await fetch(`${API}/api/locations/${id}`, { method: "DELETE" }); reload(); };
  const research = async () => {
    await fetch(`${API}/api/companies/${company.id}/refresh-research`, { method: "POST" });
    setResearching(true);
    onNotice("Research started — profiles take 2-5 minutes, then the topic graph rebuilds with the new industry's questions. This page updates itself; the 🔔 bell pings when it's done.");
  };

  return (
    <div className="mt-6 rounded-xl border bg-white p-5">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Locations & verticals</div>
        <button onClick={research} disabled={researching}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
          {researching ? "⏳ Researching… (page updates itself)" : unprofiled > 0 ? `Research new additions (${unprofiled} waiting)` : "Research new additions"}
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-500">Each location × vertical gets its own researched profile, its own topic questions, and genuinely local content — this is what drives customization.</p>
      {company.locations?.map((l: any) => (
        <div key={l.id} className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">
          <div className="flex items-center justify-between">
            <div><b>{l.name}</b> — {l.city}{l.state ? `, ${l.state}` : ""} · {l.country ?? "US"}</div>
            <button onClick={() => removeLocation(l.id)} className="text-xs text-red-500">remove</button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {l.verticals.map((v: any) => (
              <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs shadow-sm">
                {v.name}{v.profile ? " ✓" : " (researching…)"}
                <button onClick={() => removeVertical(v.id)} className="text-red-400">×</button>
              </span>
            ))}
            <input placeholder="add vertical (e.g. Legal)" value={vertDraft[l.id] ?? ""}
              onChange={(e) => setVertDraft((d) => ({ ...d, [l.id]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addVertical(l.id)}
              className="w-44 rounded border px-2 py-1 text-xs" />
            <button onClick={() => addVertical(l.id)} className="rounded bg-gray-900 px-2 py-1 text-xs text-white">Add</button>
          </div>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
        <label className="text-xs">Country<br />
          <select value={loc.country}
            onChange={(e) => setLoc({ ...loc, country: e.target.value, state: "" })}
            className="mt-1 rounded border px-2 py-1">
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-xs">City<br /><input value={loc.city} onChange={(e) => setLoc({ ...loc, city: e.target.value })} className="mt-1 rounded border px-2 py-1" /></label>
        <label className="text-xs">{loc.country === "CA" ? "Province" : "State"}<br />
          <select value={loc.state}
            onChange={(e) => setLoc({ ...loc, state: e.target.value })}
            className="mt-1 rounded border px-2 py-1">
            <option value="">—</option>
            {(STATES_BY_COUNTRY[loc.country] ?? []).map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        <label className="text-xs">Label (optional)<br /><input value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} placeholder="Duncan BC HQ" className="mt-1 rounded border px-2 py-1" /></label>
        <button onClick={addLocation} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white">Add location</button>
      </div>
    </div>
  );
}

function PublishTargets({ company, reload, onNotice, companyId }: { company: any; reload: () => void; onNotice: (m: string) => void; companyId: string }) {
  const [wp, setWp] = useState({ name: "", baseUrl: "", username: "", appPassword: "" });
  const [showWp, setShowWp] = useState(false);
  if (!company) return null;
  const addWp = async () => {
    if (!wp.baseUrl || !wp.username || !wp.appPassword) return;
    await fetch(`${API}/api/companies/${companyId}/publish-targets`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "wordpress", name: wp.name || "WordPress", isDefault: !company.publishTargets?.length, config: { baseUrl: wp.baseUrl, username: wp.username, appPassword: wp.appPassword } }),
    });
    setWp({ name: "", baseUrl: "", username: "", appPassword: "" }); setShowWp(false); reload();
    onNotice("WordPress site connected — the app password is stored encrypted. Set it as default to publish there.");
  };
  const setDefault = async (id: string) => { await fetch(`${API}/api/publish-targets/${id}/default`, { method: "PATCH" }); reload(); };
  const remove = async (id: string) => { await fetch(`${API}/api/publish-targets/${id}`, { method: "DELETE" }); reload(); };
  return (
    <div className="mt-6 rounded-xl border bg-white p-5">
      <div className="font-semibold">Where blogs publish</div>
      <div className="mt-2 space-y-2 text-sm">
        {company.publishTargets?.map((t: any) => (
          <div key={t.id} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
            <div>{t.name} <span className="text-xs text-gray-400">({t.kind === "custom" ? "octane" : t.kind})</span>
              {t.kind === "custom" && <OctaneTargetStatus targetId={t.id} />}
            </div>
            <div className="flex items-center gap-2 text-xs">
              {t.kind === "custom" && (
                <button onClick={async () => {
                  await fetch(`${API}/api/publishers/octane/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: t.id }) });
                  onNotice("Octane login window opening on this computer — log in, then close the browser window.");
                }} className="text-blue-600">connect session</button>
              )}
              {t.isDefault ? <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700">default</span>
                : <button onClick={() => setDefault(t.id)} className="text-blue-600">make default</button>}
              <button onClick={() => remove(t.id)} className="text-red-500">remove</button>
            </div>
          </div>
        ))}
      </div>
      {!showWp ? (
        <button onClick={() => setShowWp(true)} className="mt-3 rounded-lg border px-3 py-1.5 text-sm">+ Connect a WordPress site</button>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3">
          <label className="text-xs">Name<br /><input value={wp.name} onChange={(e) => setWp({ ...wp, name: e.target.value })} className="mt-1 rounded border px-2 py-1" /></label>
          <label className="text-xs">Site URL<br /><input value={wp.baseUrl} onChange={(e) => setWp({ ...wp, baseUrl: e.target.value })} placeholder="https://example.com" className="mt-1 w-52 rounded border px-2 py-1" /></label>
          <label className="text-xs">Username<br /><input value={wp.username} onChange={(e) => setWp({ ...wp, username: e.target.value })} className="mt-1 w-32 rounded border px-2 py-1" /></label>
          <label className="text-xs">Application password<br /><input type="password" value={wp.appPassword} onChange={(e) => setWp({ ...wp, appPassword: e.target.value })} className="mt-1 w-44 rounded border px-2 py-1" /></label>
          <button onClick={addWp} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white">Connect</button>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-400">Octane publishing uses the "Connect Octane" session from the dashboard. WordPress uses an application password (WP admin → Users → Application Passwords), stored encrypted.</p>
    </div>
  );
}

function Automation({ companyId, onNotice }: { companyId: string; onNotice: (m: string) => void }) {
  const [sched, setSched] = useState<{ enabled: boolean; next?: string | null } | null>(null);
  const load = useCallback(() => fetch(`${API}/api/companies/${companyId}/schedule`).then((r) => r.json()).then(setSched), [companyId]);
  useEffect(() => { load(); }, [load]);
  const toggle = async () => {
    if (sched?.enabled) {
      await fetch(`${API}/api/companies/${companyId}/schedule`, { method: "DELETE" });
      onNotice("Weekly automation paused.");
    } else {
      await fetch(`${API}/api/companies/${companyId}/schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      onNotice("Weekly automation on: every Monday 6am it re-crawls, refreshes research, pulls security/EOL triggers, runs live gap probes and drafts articles into your review queue.");
    }
    load();
  };
  return (
    <div className="mt-6 rounded-xl border bg-white p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">Weekly automation</div>
          <p className="mt-1 text-xs text-gray-500">
            {sched?.enabled
              ? <>ON — next run {sched.next ? new Date(sched.next).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Monday 6:00 AM"}. Re-crawls, re-measures live AI visibility, adds fresh topics (including breaking security/EOL events) and drafts new articles for review.</>
              : "OFF — the system only writes when you tell it to."}
          </p>
        </div>
        <button onClick={toggle} className={`rounded-full px-4 py-2 text-sm font-semibold ${sched?.enabled ? "bg-green-600 text-white" : "bg-gray-200 text-gray-700"}`}>
          {sched?.enabled ? "ON" : "OFF"}
        </button>
      </div>
    </div>
  );
}


/** Per-target Octane session health chip (each target keeps its own browser profile). */
function OctaneTargetStatus({ targetId }: { targetId: string }) {
  const [st, setSt] = useState<{ connected: boolean; ageHours?: number; login?: { state: string; detail: string | null } | null } | null>(null);
  useEffect(() => {
    const load = () => fetch(`${API}/api/publishers/octane/status?targetId=${targetId}`)
      .then((r) => (r.ok ? r.json() : null)).then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [targetId]);
  if (!st) return null;
  return (
    <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${st.connected ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
      {st.connected ? `session ok · ${st.ageHours ?? 0}h` : st.login?.state === "waiting_for_login" ? "waiting for login…" : "no session"}
    </span>
  );
}
