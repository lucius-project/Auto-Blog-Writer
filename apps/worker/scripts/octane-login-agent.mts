/**
 * HOST-SIDE Octane login agent — the one piece that cannot live in Docker.
 * Waits on redis for "Connect Octane" clicks from the containerized API and
 * opens the real (headed) Chromium window on this desktop for the human
 * Cloudflare check. Keep it running:  npm run octane:login-agent
 */
import IORedis from "ioredis";
import { spawn } from "node:child_process";

const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63790", { maxRetriesPerRequest: null });
const uid = process.getuid?.() ?? 1000;
console.log("[login-agent] waiting for Connect Octane clicks…");
for (;;) {
  const res = await redis.blpop("abw:octane-login-requests", 0);
  if (!res) continue;
  try {
    const { profileDir, suffix } = JSON.parse(res[1]);
    console.log(`[login-agent] opening login window (profile: ${profileDir})`);
    const child = spawn("npx", ["tsx", "scripts/octane-login.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0",
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
        OCTANE_PROFILE_DIR: profileDir,
        OCTANE_STATUS_SUFFIX: suffix ?? "",
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (e) {
    console.error("[login-agent] bad request:", (e as Error).message);
  }
}
