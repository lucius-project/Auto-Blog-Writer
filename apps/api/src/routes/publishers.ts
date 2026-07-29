import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/queues.js";

const WORKER_DIR = path.resolve(process.cwd(), "../worker");

/** WSLg display env so headed browsers open on the Windows desktop. */
function wslgEnv(extra: Record<string, string> = {}) {
  const uid = process.getuid?.() ?? 1000;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    ...extra,
  };
}

/** Resolve an octane target's profileDir + status-file suffix. */
async function octaneProfile(targetId?: string) {
  if (!targetId) return { profileDir: "secrets/octane-profile", suffix: "" };
  const t = await prisma.publishTarget.findUnique({ where: { id: targetId } });
  const cfg = (t?.config as any) ?? {};
  const profileDir: string = cfg.profileDir ?? "secrets/octane-profile";
  // the shared default profile keeps the legacy status filenames
  const suffix = profileDir === "secrets/octane-profile" ? "" : `-${targetId}`;
  return { profileDir, suffix };
}

export async function publisherRoutes(app: FastifyInstance) {
  // Per-target session status (no targetId = the shared default profile)
  app.get("/publishers/octane/status", async (req) => {
    const { targetId } = (req.query ?? {}) as { targetId?: string };
    const { suffix } = await octaneProfile(targetId);
    const stateFile = path.join(WORKER_DIR, `secrets/octane-state${suffix}.json`);
    const statusFile = path.join(WORKER_DIR, `secrets/octane-login-status${suffix}.json`);
    let session: { connected: boolean; savedAt?: string; ageHours?: number } = { connected: false };
    try {
      const s = await stat(stateFile);
      session = { connected: true, savedAt: s.mtime.toISOString(), ageHours: Math.round((Date.now() - s.mtime.getTime()) / 36e5) };
    } catch { /* not connected */ }
    let login: { state: string; detail: string | null; at: string } | null = null;
    try {
      login = JSON.parse(await readFile(statusFile, "utf8"));
      // stale status from an old attempt is noise
      if (login && Date.now() - new Date(login.at).getTime() > 15 * 60e3 && login.state !== "saved") login = null;
    } catch { /* none */ }
    return { ...session, login };
  });

  app.post("/publishers/octane/login", async (req) => {
    const { targetId } = (req.body ?? {}) as { targetId?: string };
    const { profileDir, suffix } = await octaneProfile(targetId);
    if (process.env.OCTANE_LOGIN_MODE === "redis") {
      // running in a container: no display here — the host-side login agent
      // (npm run octane:login-agent) picks this up and opens the window
      await redis.lpush("abw:octane-login-requests", JSON.stringify({ profileDir, suffix, at: Date.now() }));
      return { ok: true, message: "Opening the login window on this computer…" };
    }
    const child = spawn("npx", ["tsx", "scripts/octane-login.ts"], {
      cwd: WORKER_DIR,
      env: wslgEnv({ OCTANE_PROFILE_DIR: profileDir, OCTANE_STATUS_SUFFIX: suffix }),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, message: "Opening the login window on this computer…" };
  });
}
