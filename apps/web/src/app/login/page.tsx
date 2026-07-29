"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

/** Sign in — or, on first run (no users yet), create the owner account. */
export default function Login() {
  const [setupMode, setSetupMode] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API}/api/auth/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d.user) location.href = "/";
        else setSetupMode(!!d.setup);
      })
      .catch(() => setSetupMode(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const path = setupMode ? "register" : "login";
    const body = setupMode ? { email, name, password } : { email, password };
    const res = await fetch(`${API}/api/auth/${path}`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) { location.href = "/"; return; }
    const d = await res.json().catch(() => ({}));
    setError(d.error ?? `failed (${res.status})`);
  };

  if (setupMode === null) return <main className="mx-auto max-w-sm px-6 py-24 text-center text-gray-400">Loading…</main>;

  return (
    <main className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-bold">Automated Blog Writer</h1>
      <p className="mt-1 text-sm text-gray-500">
        {setupMode
          ? "First run — create the owner account. After this, signing in is required."
          : "Sign in to continue."}
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {setupMode && (
          <div>
            <label className="text-xs font-medium text-gray-600">Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" placeholder="Adam Spencer" />
          </div>
        )}
        <div>
          <label className="text-xs font-medium text-gray-600">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" placeholder="you@company.com" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Password{setupMode ? " (8+ characters)" : ""}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setupMode ? 8 : 1}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
        </div>
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button disabled={busy} className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "…" : setupMode ? "Create owner account" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
