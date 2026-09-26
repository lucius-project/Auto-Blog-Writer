"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

type Item = { id: string; type: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string };

const ICON: Record<string, string> = {
  batch_done: "✅", publish_failed: "⚠️", weekly_done: "🔁", review_needed: "📝", credits_exhausted: "⛔", info: "ℹ️",
};

/** Bell + dropdown; polls every 20s. */
export default function NotificationsBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() =>
    fetch(`${API}/api/notifications`).then((r) => (r.ok ? r.json() : { items: [], unreadCount: 0 }))
      .then((d) => { setItems(d.items ?? []); setUnread(d.unreadCount ?? 0); })
      .catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const readAll = async () => { await fetch(`${API}/api/notifications/read-all`, { method: "POST" }); load(); };
  const clickItem = async (n: Item) => {
    if (!n.readAt) await fetch(`${API}/api/notifications/${n.id}/read`, { method: "POST" });
    if (n.href?.startsWith("http")) { window.open(n.href, "_blank", "noopener"); load(); }
    else if (n.href) location.href = n.href; else load();
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="relative rounded-lg border bg-white px-3 py-1.5 text-sm">
        🔔
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button onClick={readAll} className="text-xs text-blue-600">Mark all read</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <button key={n.id} onClick={() => clickItem(n)}
                className={`block w-full border-b px-4 py-3 text-left last:border-0 hover:bg-gray-50 ${n.readAt ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-2">
                  <span>{ICON[n.type] ?? "ℹ️"}</span>
                  <div>
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="mt-0.5 text-xs text-gray-500">{n.body}</div>}
                    <div className="mt-0.5 text-[10px] text-gray-400">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              </button>
            ))}
            {items.length === 0 && <div className="px-4 py-8 text-center text-sm text-gray-400">Nothing yet — batch results, publish failures and weekly runs land here.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
