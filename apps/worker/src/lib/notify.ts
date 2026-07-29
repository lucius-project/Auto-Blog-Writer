import { prisma } from "./prisma.js";

/**
 * In-app notification (+ optional webhook if the company configured one in
 * settings.notifyWebhookUrl — posts Slack/Teams-compatible {text}).
 */
export async function notify(opts: {
  companyId?: string | null;
  type: "batch_done" | "publish_failed" | "weekly_done" | "review_needed" | "info";
  title: string;
  body?: string;
  href?: string;
}) {
  try {
    await prisma.notification.create({
      data: { companyId: opts.companyId ?? null, type: opts.type, title: opts.title, body: opts.body, href: opts.href },
    });
  } catch (e) {
    console.warn(`[notify] db write failed: ${(e as Error).message}`);
  }
  try {
    if (!opts.companyId) return;
    const company = await prisma.company.findUnique({ where: { id: opts.companyId } });
    const url = ((company?.settings as any) ?? {}).notifyWebhookUrl;
    if (url) {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${opts.title}${opts.body ? ` — ${opts.body}` : ""}` }),
      });
    }
  } catch (e) {
    console.warn(`[notify] webhook failed: ${(e as Error).message}`);
  }
}
