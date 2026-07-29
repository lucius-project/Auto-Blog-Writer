/**
 * Octane login via a PLAIN (non-automated) Chromium — no CDP, no Playwright
 * control, so Cloudflare Turnstile sees a normal browser. The session lands
 * in a persistent profile (secrets/octane-profile) that the headless
 * publisher reuses. Flow: window opens -> human logs in -> human CLOSES the
 * window -> we verify the session headlessly and report status.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const profileDir = path.resolve(process.env.OCTANE_PROFILE_DIR ?? "secrets/octane-profile");
const suffix = process.env.OCTANE_STATUS_SUFFIX ?? "";
const statusPath = `secrets/octane-login-status${suffix}.json`;
const markerPath = `secrets/octane-state${suffix}.json`;
mkdirSync("secrets", { recursive: true });
const setStatus = (state: string, detail?: string) =>
  writeFileSync(statusPath, JSON.stringify({ state, detail: detail ?? null, at: new Date().toISOString() }));

try {
  setStatus("launching");
  const exe = chromium.executablePath();
  const child = spawn(exe, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1100,850",
    "https://octane.site/login",
  ], { stdio: "ignore" });
  setStatus("waiting_for_login", "Browser window open — log in (including the Turnstile), then CLOSE the browser window");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  setStatus("verifying", "Checking the saved session…");
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await ctx.newPage();
  await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000);
  const ok = !page.url().includes("/login");
  await ctx.close();
  if (ok) {
    writeFileSync(markerPath, JSON.stringify({ verifiedAt: new Date().toISOString(), profileDir }));
    setStatus("saved", "Session verified — headless publishing is ready");
    process.exit(0);
  } else {
    setStatus("error", "Session check failed — the login didn't stick. Try again and make sure you reach the Octane dashboard before closing the window.");
    process.exit(1);
  }
} catch (e: any) {
  setStatus("error", String(e?.message ?? e).slice(0, 300));
  process.exit(1);
}
