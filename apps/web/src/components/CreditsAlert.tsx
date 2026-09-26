"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";
const SNOOZE_KEY = "abw.creditsAlertSnoozedUntil";

type Credits = {
  status: "ok" | "low" | "exhausted" | "unknown";
  remaining: number | null;
  warnBelow: number;
  lastCreditErrorAt: string | null;
  renewUrl: string;
};

const readSnooze = () => { try { return Number(localStorage.getItem(SNOOZE_KEY) ?? 0); } catch { return 0; } };
const writeSnooze = (until: number) => { try { localStorage.setItem(SNOOZE_KEY, String(until)); } catch { /* private mode */ } };

/**
 * OpenRouter credit watchdog, mounted once in the root layout. Low or
 * exhausted credit pops a modal with a renew link; "Remind me later" snoozes
 * it to a slim banner that stays until the balance is topped up.
 */
export default function CreditsAlert() {
  const path = usePathname();
  const [credits, setCredits] = useState<Credits | null>(null);
  const [snoozedUntil, setSnoozedUntil] = useState(0);

  const load = useCallback(() =>
    fetch(`${API}/api/system/ai-credits`).then((r) => (r.ok ? r.json() : null)).then(setCredits).catch(() => {}), []);

  useEffect(() => {
    if (path.startsWith("/login")) return;
    setSnoozedUntil(readSnooze());
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    window.addEventListener("focus", load);
    return () => { clearInterval(t); window.removeEventListener("focus", load); };
  }, [load, path]);

  if (!credits || (credits.status !== "low" && credits.status !== "exhausted")) return null;
  const exhausted = credits.status === "exhausted";
  const balance = credits.remaining !== null ? `$${credits.remaining.toFixed(2)}` : "unknown";

  const snooze = () => {
    const until = Date.now() + (exhausted ? 60 : 24 * 60) * 60 * 1000;
    writeSnooze(until);
    setSnoozedUntil(until);
  };

  if (snoozedUntil > Date.now()) {
    return (
      <div className={`px-4 py-2 text-center text-sm ${exhausted ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"}`}>
        {exhausted ? "AI credits are used up — writing, research and images are failing." : `AI credits are running low (${balance} left).`}{" "}
        <a href={credits.renewUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">Add credits</a>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="credits-alert-title">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden>{exhausted ? "⛔" : "⚠️"}</span>
          <div>
            <h2 id="credits-alert-title" className="text-lg font-semibold">
              {exhausted ? "AI credits are used up" : "AI credits are running low"}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              OpenRouter balance: <span className="font-semibold text-gray-900">{balance}</span>
              {!exhausted && <> (warning below ${credits.warnBelow})</>}
            </p>
            <p className="mt-3 text-sm text-gray-600">
              {exhausted
                ? "Article writing, rewrites, research, gap analysis and cartoon images will fail until credits are added. Posts publish without images in the meantime."
                : "When it runs out, article writing, research and images stop working. Top up now to keep the weekly run going."}
            </p>
            {credits.lastCreditErrorAt && (
              <p className="mt-2 text-xs text-red-600">Last failed AI call: {new Date(credits.lastCreditErrorAt).toLocaleString()}</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={snooze} className="rounded-lg border px-4 py-2 text-sm">Remind me later</button>
          <a href={credits.renewUrl} target="_blank" rel="noopener noreferrer"
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">
            Add credits at OpenRouter ↗
          </a>
        </div>
      </div>
    </div>
  );
}
