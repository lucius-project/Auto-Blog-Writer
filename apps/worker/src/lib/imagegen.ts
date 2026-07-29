import { prisma } from "./prisma.js";
import { chat } from "./openrouter.js";

const BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL ?? "google/gemini-2.5-flash-image";

/**
 * Funny cartoon generator for blog posts. Two stages:
 *  1. text model invents a topic-specific sight gag (funnier than a generic prompt)
 *  2. image model renders it as a wide (1.91:1-ish) single-panel cartoon, no words
 * Returns the PNG buffer + dimensions; cost is logged to DataFetchLog.
 */
export async function generateCartoon(opts: {
  companyId: string;
  title: string;
  vertical?: string | null;
  blogPostId?: string;
}): Promise<{ buffer: Buffer; width: number; height: number; alt: string; gag: string }> {
  // 1. the gag
  const gag = (await chat(
    [
      {
        role: "system",
        content:
          "You write single-panel cartoon concepts for an IT company's blog. Maximum comedy: exaggerated stakes, absurd visual contrast, physical comedy. " +
          "One or two sentences describing ONE clear visual scene. No dialogue, no captions, no text in the scene. Keep it workplace-safe.",
      },
      {
        role: "user",
        content: `Blog title: "${opts.title}"${opts.vertical ? ` (industry: ${opts.vertical})` : ""}. Describe the funniest possible single-panel cartoon scene for this topic.`,
      },
    ],
    { companyId: opts.companyId, maxTokens: 200, tag: "cartoon-gag", blogPostId: opts.blogPostId },
  )).trim();

  // 2. the picture
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [{
        role: "user",
        content:
          `A hilarious single-panel cartoon, wide landscape format: ${gag} ` +
          "Bright colors, clean vector-comic style, exaggerated facial expressions, high energy. " +
          "Absolutely no words, letters, text, signs, or captions anywhere in the image.",
      }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "16:9" },
    }),
  });
  if (!res.ok) throw new Error(`imagegen ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const url: string = data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
  if (!url.startsWith("data:image/")) throw new Error("imagegen: no image in response");
  const buffer = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  // PNG IHDR dims
  let width = 1344, height = 768;
  try { width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20); } catch { /* defaults */ }

  await prisma.dataFetchLog.create({
    data: {
      companyId: opts.companyId, blogPostId: opts.blogPostId, provider: "openrouter", endpoint: `imagegen:${IMAGE_MODEL}`,
      cost: data?.usage?.cost ?? null, meta: { model: IMAGE_MODEL, usage: data?.usage ?? null, title: opts.title.slice(0, 120) },
    },
  }).catch(() => null);

  return { buffer, width, height, alt: `Cartoon: ${opts.title}`.slice(0, 140), gag };
}
