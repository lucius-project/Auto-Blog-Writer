"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import NotificationsBell from "./NotificationsBell";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Company = { id: string; name: string };
type Item = { href: string; label: string };
type Group = { key: string; label: string; items: Item[]; badge?: number };

/**
 * Persistent app shell navigation:
 *   brand -> dashboard | company switcher | grouped section menus
 *   (Overview / Content / SEO / Growth) | Settings | notifications | account
 */
export default function TopNav() {
  const path = usePathname();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const navRef = useRef<HTMLElement>(null);

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
  // close menus on route change or outside click
  useEffect(() => { setOpenMenu(null); setPickerOpen(false); }, [path]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (path.startsWith("/login")) return null;

  const overviewHref = companyId ? `/company/${companyId}` : null;
  const settingsHref = companyId ? `/company/${companyId}/settings` : null;
  const groups: Group[] = companyId ? [
    {
      key: "content", label: "Content", badge: reviewCount, items: [
        { href: `/review/${companyId}`, label: "Review queue" },
        { href: `/company/${companyId}/calendar`, label: "Calendar" },
        { href: `/company/${companyId}/batches`, label: "Batch history" },
      ],
    },
    {
      key: "seo", label: "SEO", items: [
        { href: `/company/${companyId}/checklist`, label: "Website checklist" },
        { href: `/company/${companyId}/topics`, label: "Topic Graph" },
        { href: `/company/${companyId}/sitemap`, label: "Site map" },
        { href: `/company/${companyId}/offpage`, label: "Off-page tasks" },
      ],
    },
    {
      key: "growth", label: "Growth", items: [
        { href: `/company/${companyId}/competitors`, label: "Competitors" },
        { href: `/company/${companyId}/analytics`, label: "Analytics" },
        { href: `/company/${companyId}/trends`, label: "Trends" },
      ],
    },
  ] : [];

  const pill = (active: boolean) =>
    `whitespace-nowrap rounded-lg px-2.5 py-1 text-sm font-medium ${active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`;

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

        {/* grouped section menus */}
        <nav ref={navRef} className="flex flex-1 items-center gap-x-1">
          {overviewHref && (
            <a href={overviewHref} className={pill(path === overviewHref)}>Overview</a>
          )}
          {groups.map((g) => {
            const active = g.items.some((it) => path === it.href || path.startsWith(it.href + "/"));
            const isOpen = openMenu === g.key;
            return (
              <div key={g.key} className="relative">
                <button onClick={() => setOpenMenu(isOpen ? null : g.key)}
                  className={`flex items-center gap-1 ${pill(active || isOpen)}`}>
                  {g.label}
                  {g.badge ? (
                    <span className={`rounded-full px-1.5 text-[10px] font-bold ${active || isOpen ? "bg-white/25 text-white" : "bg-red-600 text-white"}`}>
                      {g.badge}
                    </span>
                  ) : null}
                  <span className={active || isOpen ? "text-white/70" : "text-gray-400"}>▾</span>
                </button>
                {isOpen && (
                  <div className="absolute left-0 z-40 mt-1 w-52 rounded-lg border bg-white py-1 shadow-lg">
                    {g.items.map((it) => {
                      const itActive = path === it.href || path.startsWith(it.href + "/");
                      return (
                        <a key={it.href} href={it.href}
                          className={`flex items-center justify-between px-3 py-1.5 text-sm hover:bg-gray-50 ${itActive ? "font-semibold text-gray-900" : "text-gray-700"}`}>
                          {it.label}
                          {it.href.startsWith("/review/") && reviewCount > 0 && (
                            <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{reviewCount}</span>
                          )}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {settingsHref && (
            <a href={settingsHref} className={pill(path === settingsHref)}>Settings</a>
          )}
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
