import { chromium } from "playwright";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { notify } from "../lib/notify.js";

/**
 * Daily session health check across EVERY Octane publish target (each has
 * its own persistent browser profile). A successful visit refreshes the
 * session cookies; a login redirect flips the dashboard status and raises a
 * notification — long before a scheduled publish would fail.
 */
export async function octaneKeepalive() {
  const targets = await prisma.publishTarget.findMany({ where: { kind: "custom" } });
  const octane = targets.filter((t) => ((t.config as any) ?? {}).adapter === "octane");
  // legacy: no targets configured yet -> still check the shared default profile
  const checks = octane.length
    ? octane.map((t) => ({
        targetId: t.id,
        companyId: t.companyId,
        name: t.name,
        profileDir: ((t.config as any).profileDir as string) ?? "secrets/octane-profile",
      }))
    : [{ targetId: null as string | null, companyId: null as string | null, name: "default", profileDir: "secrets/octane-profile" }];

  const results: { name: string; alive: boolean }[] = [];
  for (const c of checks) {
    const suffix = c.profileDir === "secrets/octane-profile" ? "" : `-${c.targetId}`;
    const ctx = await chromium.launchPersistentContext(path.resolve(c.profileDir), {
      headless: true, args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const page = await ctx.newPage();
      await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(4000);
      const alive = !page.url().includes("/login");
      writeFileSync(`secrets/octane-login-status${suffix}.json`, JSON.stringify({
        state: alive ? "saved" : "error",
        detail: alive ? "Session healthy (daily check)" : "Session expired — press Connect Octane and log in again",
        at: new Date().toISOString(),
      }));
      if (alive) writeFileSync(`secrets/octane-state${suffix}.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), profileDir: c.profileDir }));
      if (!alive) {
        await notify({
          companyId: c.companyId,
          type: "info",
          title: `Octane session expired (${c.name})`,
          body: "Press Connect Octane on the dashboard and log in again so scheduled publishes keep working.",
          href: "/",
        });
      }
      results.push({ name: c.name, alive });
      console.log(`[octane-keepalive] ${c.name}: session ${alive ? "healthy" : "EXPIRED — owner action needed"}`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  return { results };
}
