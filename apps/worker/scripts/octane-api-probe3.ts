import { chromium } from "playwright";
import path from "node:path";
const ctx = await chromium.launchPersistentContext(path.resolve("secrets/octane-profile"), {
  headless: true, args: ["--disable-blink-features=AutomationControlled"], viewport: { width: 1500, height: 950 },
});
const page = await ctx.newPage();
await page.goto("https://octane.site/page/2151890", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
const result = await page.evaluate(`(async () => {
  const html = await fetch("/page/2151890/tags").then(r => r.text());
  const token = (html.match(/name="_token"[^>]*value="([^"]+)"/) || [])[1] || (document.querySelector('meta[name="csrf-token"]')||{}).content;
  const fd = new URLSearchParams();
  fd.set("_token", token);
  fd.set("pageid", "2151890");
  fd.set("titletag", "What Happens If You Fail HIPAA Compliance? | 911 IT");
  fd.set("metadesc", "HIPAA violations trigger OCR investigations, fines from $100 to $50,000 per violation, and mandatory corrective action plans. Learn the penalties and prevention.");
  fd.set("noindex", "0");
  fd.set("pagelang", "");
  fd.set("bypasscache", "0");
  const res = await fetch("/page/2151890/seo", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, body: fd });
  const body = await res.text();
  return res.status + " :: " + body.slice(0, 200);
})()`);
console.log("POST /seo:", result);
// schema too
const result2 = await page.evaluate(`(async () => {
  const token = (document.querySelector('meta[name="csrf-token"]')||{}).content;
  const schema = { "@context": "https://schema.org", "@graph": [{ "@type": "BlogPosting", "headline": "What Happens If a Healthcare & Dental Business Fails HIPAA Compliance?", "datePublished": "2026-07-20" }] };
  const res = await fetch("/page/2151890/schema/update", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token, "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify({ schema, pageschemamode: "add" }) });
  return res.status + " :: " + (await res.text()).slice(0, 200);
})()`);
console.log("POST /schema/update:", result2);
// verify persisted
const verify = await page.evaluate(`fetch("/page/2151890/tags").then(r => r.text()).then(h => {
  const m = h.match(/name="metadesc"[^>]*>([^<]*)</) || h.match(/id="metadesc"[^>]*>([\\s\\S]{0,80})</);
  const t = h.match(/name="titletag"[^>]*value="([^"]*)"/);
  return JSON.stringify({ titletag: t && t[1], metadesc: m && m[1] && m[1].slice(0, 60) });
})`);
console.log("verify:", verify);
await ctx.close();
