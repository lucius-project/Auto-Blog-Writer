"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Field = { path: string; label: string; hint?: string; list?: boolean; verticalOnly?: boolean };

// SB7 order: hero → problem → guide → plan → call to action → stakes → success
const SECTIONS: { title: string; fields: Field[] }[] = [
  { title: "1 · The hero (your customer)", fields: [
    { path: "character.who", label: "Who they are", hint: "role + business type + size" },
    { path: "character.wants", label: "What they want", hint: "the ONE thing, tied to survival" },
  ] },
  { title: "2 · Their problem", fields: [
    { path: "problem.villain", label: "Villain", hint: "the root cause, as one antagonist" },
    { path: "problem.external", label: "External problem", hint: "the tangible problem" },
    { path: "problem.internal", label: "Internal problem", hint: "how it makes them feel" },
    { path: "problem.philosophical", label: "Philosophical problem", hint: "why it's just wrong" },
  ] },
  { title: "3 · Meets a guide (us)", fields: [
    { path: "guide.empathy", label: "Empathy", hint: "one statement per line", list: true },
    { path: "guide.authority", label: "Authority", hint: "real proof only, one per line", list: true },
  ] },
  { title: "4 · Who gives them a plan", fields: [
    { path: "plan.process", label: "3-step plan", hint: "one step per line", list: true },
    { path: "plan.agreement", label: "Agreement / promises", hint: "only what you actually promise", list: true },
  ] },
  { title: "5 · And calls them to action", fields: [
    { path: "callToAction.direct", label: "Direct CTA" },
    { path: "callToAction.transitional", label: "Transitional CTA", hint: "low-commitment offer (guide, checklist)" },
  ] },
  { title: "6 · Stakes & 7 · success", fields: [
    { path: "failure", label: "Failure — what's at stake", hint: "one per line", list: true },
    { path: "success", label: "Success — life after", hint: "one per line", list: true },
    { path: "transformation.from", label: "Transformation: from" },
    { path: "transformation.to", label: "Transformation: to" },
    { path: "oneLiner", label: "One-liner" },
  ] },
  { title: "Voice & differentiation", fields: [
    { path: "samenessToAvoid", label: "Sea of sameness — never lead with", hint: "one per line", list: true },
    { path: "dayInTheLife", label: "Day in the life", verticalOnly: true },
    { path: "storyHooks", label: "Story hooks (article openings)", hint: "one per line", list: true, verticalOnly: true },
    { path: "vocabulary", label: "Their vocabulary", hint: "one per line", list: true, verticalOnly: true },
  ] },
];

const get = (o: any, path: string) => path.split(".").reduce((a, k) => a?.[k], o);
const set = (o: any, path: string, v: unknown) => {
  const keys = path.split(".");
  const out = { ...o };
  let cur = out;
  keys.slice(0, -1).forEach((k) => { cur[k] = { ...(cur[k] ?? {}) }; cur = cur[k]; });
  cur[keys[keys.length - 1]!] = v;
  return out;
};

// drop blank lines left over from list editing before saving
const clean = (o: any): any => Array.isArray(o) ? o.map((x) => String(x).trim()).filter(Boolean)
  : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clean(v)])) : o;

export function BrandScriptEditor({ company, reload, onNotice }: { company: any; reload: () => void; onNotice: (m: string) => void }) {
  const [target, setTarget] = useState<string>("company");
  const [draft, setDraft] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const verticals: { id: string; label: string; profile: any }[] = (company?.locations ?? []).flatMap((l: any) =>
    l.verticals.map((v: any) => ({ id: v.id, label: `${v.name} — ${l.city}`, profile: v.profile })));
  const selected = target === "company" ? company?.profile?.brandScript : verticals.find((v) => v.id === target)?.profile?.brandScript;
  const missing = (company && !company.profile?.brandScript ? 1 : 0) + verticals.filter((v) => !v.profile?.brandScript).length;

  // load the stored script unless the user has unsaved edits
  useEffect(() => { if (!dirty) setDraft(selected ?? null); }, [target, selected, dirty]);
  // keep polling while research is still filling scripts in
  useEffect(() => {
    if (!missing) return;
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [missing, reload]);
  if (!company) return null;

  const url = target === "company"
    ? `${API}/api/companies/${company.id}/brandscript`
    : `${API}/api/companies/${company.id}/verticals/${target}/brandscript`;

  const save = async () => {
    setSaving(true);
    const { editedAt: _e, ...body } = draft ?? {};
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(clean(body)) });
    setSaving(false);
    if (!r.ok) { onNotice(`Save failed: ${(await r.json().catch(() => ({}))).error ?? r.status}`); return; }
    setDirty(false);
    reload();
    onNotice("BrandScript saved — every new article uses it from now on.");
  };
  const regenerate = async () => {
    if (!confirm("Replace this BrandScript with a freshly researched one? Your edits to it will be lost.")) return;
    await fetch(`${API}/api/companies/${company.id}/brandscript/regenerate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(target === "company" ? {} : { verticalId: target }),
    });
    setDirty(false);
    reload();
    onNotice("Regenerating — takes about a minute. This panel updates itself.");
  };
  const switchTarget = (t: string) => {
    if (dirty && !confirm("Discard unsaved BrandScript changes?")) return;
    setDirty(false);
    setTarget(t);
  };
  const edit = (path: string, v: unknown) => { setDraft((d: any) => set(d ?? {}, path, v)); setDirty(true); };

  return (
    <div className="mt-6 rounded-xl border bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">StoryBrand BrandScripts</div>
        {missing > 0 && <span className="text-xs text-amber-700">⏳ {missing} still being researched…</span>}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Every article is written from these (Donald Miller's SB7): your customer is the hero, you're the guide.
        The company script supplies the guide, plan and calls to action; each industry's script supplies that
        reader's own problems, stakes and picture of success. Edit anything that doesn't sound like your customers.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={target} onChange={(e) => switchTarget(e.target.value)} className="rounded border px-2 py-1 text-sm">
          <option value="company">Company (guide · plan · CTA){company.profile?.brandScript ? "" : " — pending"}</option>
          {verticals.map((v) => (
            <option key={v.id} value={v.id}>{v.label}{v.profile?.brandScript ? "" : " — pending"}</option>
          ))}
        </select>
        <button onClick={save} disabled={!dirty || saving}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={regenerate} disabled={!selected}
          className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50">Regenerate</button>
        {selected?.editedAt && <span className="text-xs text-gray-400">edited {new Date(selected.editedAt).toLocaleDateString()}</span>}
      </div>

      {!draft ? (
        <p className="mt-4 text-sm text-gray-500">Not researched yet — it appears here automatically once research finishes.</p>
      ) : (
        <div className="mt-4 space-y-5">
          {SECTIONS.map((s) => {
            const fields = s.fields.filter((f) => !f.verticalOnly || target !== "company");
            return (
              <div key={s.title}>
                <div className="text-sm font-medium text-gray-800">{s.title}</div>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {fields.map((f) => {
                    const v = get(draft, f.path);
                    const value = f.list ? ((v ?? []) as string[]).join("\n") : (v ?? "");
                    return (
                      <label key={f.path} className="text-xs text-gray-600">
                        {f.label}{f.hint && <span className="text-gray-400"> — {f.hint}</span>}
                        <textarea value={value} rows={f.list ? 4 : 2}
                          onChange={(e) => edit(f.path, f.list
                            ? e.target.value.split("\n").map((x) => x.trimStart()).filter((x, i, a) => x || i === a.length - 1)
                            : e.target.value || null)}
                          className="mt-1 block w-full rounded border px-2 py-1 text-sm text-gray-900" />
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
