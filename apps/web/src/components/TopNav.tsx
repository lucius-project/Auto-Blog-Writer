"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import NotificationsBell from "./NotificationsBell";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Company = { id: string; name: string };

/**
 * Persistent app shell navigation. Everywhere, always:
 *   brand -> dashboard | company switcher | section tabs for the current
 *   company | notifications | account
 */
export default function TopNav() {
  const path = usePathname();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);

  // company context from the url: /company/{id}/... or /review/{id}
  const companyId = path.match(/^\/company\/([^/]+)/)?.[1] ?? path.match(/^\/review\/([^/]+)/)?.[1] ?? null;
  const company = companies.find((c) => c.id === companyId);

  useEffect(() => {
    fetch(`${API}/api/companies`).then((r) => (r.ok ? r.json() : [])).then(setCompanies).catch(() => {});
  }, []);
  useEffect(() => {
    if (!companyId) { setReviewCount(0); return; }
    const load = () => fetch(`${API}/api/companies/${companyId}/review`)
      .then((r) => (r.ok ? r.json() : [])).then((d) => setReviewCount(Array.isArray(d) ? d.length : 0)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [companyId]);

  if (path.startsWith("/login")) return null;

  const tabs = companyId ? [
    { href: `/company/${companyId}`, label: "Posts" },
    { href: `/company/${companyId}/calendar`, label: "Calendar" },
    { href: `/review/${companyId}`, label: reviewCount ? `Review (${reviewCount})` : "Review" },
    { href: `/company/${companyId}/topics`, label: "Topics" },
    { href: `/company/${companyId}/trends`, label: "Trends" },
    { href: `/company/${companyId}/analytics`, label: "Analytics" },
    { href: `/company/${companyId}/offpage`, label: "Off-page" },
    { href: `/company/${companyId}/batches`, label: "Batches" },
    { href: `/company/${companyId}/settings`, label: "Settings" },
  ] : [];

  return (
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <a href="/" className="shrink-0 text-sm font-bold tracking-tight">
          ✍️ Blog Writer
        </a>

        {/* company switcher */}
        <div className="relative">
          <button onClick={() => setPickerOpen(!pickerOpen)}
            className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50">
            {company?.name ?? "Choose company"} <span className="text-gray-400">▾</span>
          </button>
          {pickerOpen && (
            <div className="absolute left-0 z-40 mt-1 w-56 rounded-lg border bg-white py-1 shadow-lg">
              {companies.map((c) => (
                <a key={c.id} href={`/company/${c.id}`} onClick={() => setPickerOpen(false)}
                  className={`block px-3 py-1.5 text-sm hover:bg-gray-50 ${c.id === companyId ? "font-semibold" : ""}`}>
                  {c.name}
                </a>
              ))}
              <a href="/" className="block border-t px-3 py-1.5 text-sm text-blue-600 hover:bg-gray-50">All companies (dashboard)</a>
            </div>
          )}
        </div>

        {/* section tabs */}
        <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const active = path === t.href;
            return (
              <a key={t.href} href={t.href}
                className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-sm font-medium ${active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}>
                {t.label}
              </a>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <NotificationsBell />
          <AccountBadge />
        </div>
      </div>
    </header>
  );
}

/** Signed-in chip + sign out; setup nudge until the first login exists. */
function AccountBadge() {
  const [me, setMe] = useState<{ setup: boolean; user: { name: string } | null } | null>(null);
  useEffect(() => {
    fetch(`${API}/api/auth/me`).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);
  if (!me) return null;
  if (me.setup) {
    return (
      <a href="/login" className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
        Create your login
      </a>
    );
  }
  if (!me.user) return null;
  return (
    <button
      onClick={async () => { await fetch(`${API}/api/auth/logout`, { method: "POST" }); location.href = "/login"; }}
      title="Sign out"
      className="rounded-lg border bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
      {me.user.name} ↩
    </button>
  );
}
