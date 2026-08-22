import { chromium, type Page } from "playwright";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Publisher, PublishArticle, PublishResult } from "./types.js";

/**
 * Octane (DynamiX / octane.site) adapter. Drives the admin headlessly with
 * the persistent profile created by the human login helper (Cloudflare
 * Turnstile is never automated).
 *
 * Articles are REAL Octane blog articles (mapped 2026-07-21 with the owner):
 * the article page type has native inputs (content, excerpt, preview/hero
 * image, publish state) saved through the admin's own endpoints — the same
 * fields a human fills in the normal editor. No bolted-on sections, so the
 * article is fully editable in the normal Octane content editor afterwards.
 *
 * Endpoints (same-origin from the admin session):
 *   POST /media/customupload/0            multipart "file" -> {details:{filename}}
 *   POST /inputs/update                   native article fields incl. content
 *   POST /page/{id}/seo                   title tag + meta description
 *   POST /page/{id}/schema/update         JSON-LD graph
 *   POST /page/{id} (_method=PUT)         publish state + schedule (UTC)
 * Page creation itself stays in the UI (category + layout wiring).
 */
async function clickHard(locator: import("playwright").Locator): Promise<void> {
  try {
    await locator.click({ timeout: 8000 });
  } catch {
    await locator.evaluate((el) => (el as { click(): void }).click());
  }
}

function utcStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Upload a PNG from disk into the Octane media library; returns the stored filename. */
export async function uploadImage(page: Page, filePath: string, name: string): Promise<string> {
  const b64 = readFileSync(filePath).toString("base64");
  const out = await page.evaluate(`(async () => {
    const bin = atob(${JSON.stringify("B64")});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append("file", new File([arr], ${JSON.stringify("NAME")}, { type: "image/jpeg" }));
    const token = (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const res = await fetch("/media/customupload/0", { method: "POST", headers: { "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest" }, body: fd });
    const txt = await res.text();
    let filename = "";
    try { filename = JSON.parse(txt)?.details?.filename ?? ""; } catch { /* not json */ }
    return res.status + "|" + filename;
  })()`
    .replace(JSON.stringify("B64"), JSON.stringify(b64))
    .replace(JSON.stringify("NAME"), JSON.stringify(name)));
  const [status, filename] = String(out).split("|");
  if (status !== "200" || !filename) throw new Error(`image upload returned ${out}`);
  return filename;
}

/** Fill the article's NATIVE fields (content, excerpt, images) via /inputs/update. */
export async function saveNativeContent(page: Page, pageId: string, a: PublishArticle, imgFilename: string | null): Promise<void> {
  const firstP = (a.bodyHtml.match(/<p[^>]*>(.*?)<\/p>/s) || [])[1] ?? "";
  const excerpt = firstP.replace(/<[^>]+>/g, "").slice(0, 300);
  const img = a.previewImage;
  const size = img ? JSON.stringify({ width: img.width, height: img.height, "ratio-w": Math.round((img.width / img.height) * 100) / 100, "ratio-h": Math.round((img.height / img.width) * 100) / 100 }) : "";
  const fieldsJson = JSON.stringify({
    content: a.bodyHtml,
    excerpt,
    "show-published-date": "show",
    "hide-previous-next-buttons": "show",
    "previous-next-mobile": "hide",
    "show-sidebar": "show",
    "show-breadcrumbs": "hide",
    ...(imgFilename ? {
      "preview-image[imagefile]": imgFilename,
      "preview-image[alt]": img?.alt ?? a.title,
      "preview-image[size]": size,
      "hero-image[imagefile]": imgFilename,
      "hero-image[alt]": img?.alt ?? a.title,
      "hero-image[size]": size,
    } : {}),
  });
  const out = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify("PAGEID")};
    const html = await fetch("/page/" + pid).then((r) => r.text());
    const grab = (n) => {
      const m = html.match(new RegExp('name="' + n.replace(/[[\\]]/g, "\\\\$&") + '"[^>]*value="([^"]*)"')) ||
                html.match(new RegExp('value="([^"]*)"[^>]*name="' + n.replace(/[[\\]]/g, "\\\\$&") + '"'));
      return m ? m[1] : "";
    };
    const token = grab("_token") || (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const fd = new URLSearchParams();
    fd.set("_token", token);
    fd.set("siteid", grab("siteid"));
    fd.set("pageid", pid);
    fd.set("layoutid", grab("layoutid"));
    const fields = ${JSON.stringify("FIELDS")};
    for (const [k, v] of Object.entries(JSON.parse(fields))) fd.set(k, v);
    const res = await fetch("/inputs/update", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    return String(res.status);
  })()`
    .replace(JSON.stringify("PAGEID"), JSON.stringify(pageId))
    .replace(JSON.stringify("FIELDS"), JSON.stringify(fieldsJson)));
  if (String(out) !== "200") throw new Error(`inputs/update returned ${out}`);
}

/** SEO title/description + JSON-LD schema via the admin's own endpoints. */
async function saveSeo(page: Page, pageId: string, a: PublishArticle): Promise<void> {
  const cleanTitle = a.metaTitle.replace(/\s*\|\s*911 IT\s*$/i, "");
  const seoResult = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify("PAGEID")};
    const html = await fetch("/page/" + pid + "/tags").then((r) => r.text());
    const token = (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1] || (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const fd = new URLSearchParams();
    fd.set("_token", token);
    fd.set("pageid", pid);
    fd.set("titletag", ${JSON.stringify("TITLETAG")});
    fd.set("metadesc", ${JSON.stringify("METADESC")});
    fd.set("noindex", "0");
    fd.set("pagelang", "");
    fd.set("bypasscache", "0");
    const seoRes = await fetch("/page/" + pid + "/seo", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    const schemaRes = await fetch("/page/" + pid + "/schema/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify({ schema: ${JSON.stringify("SCHEMA")}, pageschemamode: "add" }),
    });
    return seoRes.status + "/" + schemaRes.status;
  })()`
    .replace(JSON.stringify("PAGEID"), JSON.stringify(pageId))
    .replace(JSON.stringify("TITLETAG"), JSON.stringify(cleanTitle))
    .replace(JSON.stringify("METADESC"), JSON.stringify(a.metaDescription))
    .replace(JSON.stringify("SCHEMA"), JSON.stringify(a.jsonLd)));
  if (String(seoResult) !== "200/200") throw new Error(`seo api save returned ${seoResult}`);
}

/** Publish state + schedule via PUT /page/{id} (publishdate is stored in UTC). */
async function savePublishState(page: Page, pageId: string, scheduledFor: string | null): Promise<void> {
  const publishdate = utcStamp(scheduledFor ?? new Date().toISOString());
  const out = await page.evaluate(`(async () => {
    const pid = ${JSON.stringify("PAGEID")};
    const html = await fetch("/page/" + pid).then((r) => r.text());
    const grab = (n) => {
      const m = html.match(new RegExp('name="' + n + '"[^>]*value="([^"]*)"')) ||
                html.match(new RegExp('value="([^"]*)"[^>]*name="' + n + '"'));
      return m ? m[1] : "";
    };
    const token = grab("_token") || (document.querySelector('meta[name="csrf-token"]') || {}).content;
    const fd = new URLSearchParams();
    fd.set("_token", token);
    fd.set("_method", "PUT");
    fd.set("siteid", grab("siteid"));
    fd.set("published", "yes");
    fd.set("publishdate", ${JSON.stringify("PUBDATE")});
    fd.set("featured", grab("featured") || "0");
    fd.set("custom1", grab("custom1"));
    fd.set("whichupdate", "publish");
    const res = await fetch("/page/" + pid, { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
    return String(res.status);
  })()`
    .replace(JSON.stringify("PAGEID"), JSON.stringify(pageId))
    .replace(JSON.stringify("PUBDATE"), JSON.stringify(publishdate)));
  if (String(out) !== "200") throw new Error(`publish PUT returned ${out}`);
}

/** Everything after the page exists: image -> native content -> SEO -> publish. */
async function apiSteps(page: Page, pageId: string, a: PublishArticle, track: (s: string) => void): Promise<void> {
  let imgFilename: string | null = null;
  if (a.previewImage) {
    track("upload-image");
    imgFilename = await uploadImage(page, a.previewImage.filePath, `blog-${a.slug.slice(0, 40)}.jpg`);
  }
  track("native-content");
  await saveNativeContent(page, pageId, a, imgFilename);
  track("seo-save-api");
  await saveSeo(page, pageId, a);
  track("publish-api");
  await savePublishState(page, pageId, a.scheduledFor);
}

export function octanePublisher(config: { profileDir?: string }): Publisher {
  const launch = () => chromium.launchPersistentContext(path.resolve(config.profileDir ?? "secrets/octane-profile"), {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
    viewport: { width: 1500, height: 950 },
  });

  return {
    kind: "octane",

    async publish(a: PublishArticle): Promise<PublishResult> {
      let step = "launch";
      const ctx = await launch();
      const page = await ctx.newPage();
      page.on("request", (req) => {
        const u = req.url();
        if (req.method() === "POST" && u.includes("octane.site") && !u.includes("websockets")) {
          try {
            appendFileSync("/tmp/octane-endpoints.log",
              u.replace("https://octane.site", "") + " | " + String(req.postData()).slice(0, 400) + "\n");
          } catch { /* logging only */ }
        }
      });
      try {
        step = "open-content";
        await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector("text=Your Site", { timeout: 30000 });
        if (page.url().includes("/login")) {
          return { ok: false, detail: "octane session expired — press Connect Octane on the dashboard and log in again" };
        }

        step = "open-articles";
        const articlesEl = page.getByText("Articles", { exact: true }).first();
        const catId = await articlesEl.evaluate((el) => {
          const li = (el as { closest(sel: string): { getAttribute(n: string): string | null } | null }).closest("li");
          return li?.getAttribute("data-cat") ?? "";
        }).catch(() => "");
        let contextOk = false;
        for (let attempt = 0; attempt < 3 && !contextOk; attempt++) {
          if (catId) {
            await page.evaluate((h) => { (globalThis as any).location.hash = h; }, `#${catId}`);
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.waitForSelector("text=Your Site", { timeout: 30000 });
          } else {
            await clickHard(articlesEl);
          }
          await page.waitForTimeout(3000);

          step = "add-entry";
          await clickHard(page.locator('.add-entry-button').first());
          await page.getByPlaceholder(/give the page a title/i).fill(a.title, { timeout: 15000 });
          await page.waitForTimeout(1200);

          step = "verify-article-context";
          const urlField = page.getByText("PAGE URL").locator("xpath=following::input[1]");
          const autoSlug = await urlField.inputValue({ timeout: 10000 }).catch(() => "");
          if (autoSlug.startsWith("blog/")) {
            await urlField.fill(`blog/${a.slug}`);
            await page.waitForTimeout(300);
            contextOk = true;
          } else {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(1500);
          }
        }
        if (!contextOk) throw new Error("could not reach the Articles category — create modal kept opening under General Pages");

        step = "create-page";
        await clickHard(page.getByText("Create Page").first());
        // the server often creates the page even when this navigation is slow —
        // wait long, then double-check the URL before giving up (orphan trap).
        try {
          await page.waitForURL(/octane\.site\/page\/\d+/, { timeout: 60000 });
        } catch {
          await page.waitForTimeout(5000);
          if (!/octane\.site\/page\/\d+/.test(page.url())) {
            throw new Error(
              "Create Page did not navigate — the page may still have been created server-side. " +
              "If retries now fail with a taken slug, an orphan page exists: find its id (idscan) and attach it as qa.publish.externalId, then retry (update-in-place).",
            );
          }
        }
        const pageId = page.url().match(/page\/(\d+)/)?.[1];
        if (!pageId) throw new Error("no page id after create");
        await page.waitForTimeout(2000);

        await apiSteps(page, pageId, a, (s) => { step = s; });

        return { ok: true, externalId: pageId, liveUrl: `https://www.911it.com/blog/${a.slug}` };
      } catch (e: any) {
        const shot = `/tmp/octane-fail-${step}-${Date.now()}.png`;
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        return { ok: false, detail: `octane step "${step}": ${String(e?.message ?? e).slice(0, 200)} [screenshot: ${shot}]` };
      } finally {
        await ctx.close().catch(() => {});
      }
    },

    /** Rewrite-in-place: update the SAME article page (same id + slug). */
    async update(externalId: string, a: PublishArticle): Promise<PublishResult> {
      let step = "launch";
      const ctx = await launch();
      const page = await ctx.newPage();
      try {
        step = "open-content";
        await page.goto("https://octane.site/content", { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2500);
        if (page.url().includes("/login")) {
          return { ok: false, detail: "octane session expired — press Connect Octane on the dashboard and log in again" };
        }
        await apiSteps(page, externalId, a, (s) => { step = s; });
        return { ok: true, externalId, liveUrl: `https://www.911it.com/blog/${a.slug}` };
      } catch (e: any) {
        const shot = `/tmp/octane-fail-update-${step}-${Date.now()}.png`;
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        return { ok: false, detail: `octane update step "${step}": ${String(e?.message ?? e).slice(0, 200)} [screenshot: ${shot}]` };
      } finally {
        await ctx.close().catch(() => {});
      }
    },
  };
}
