import type { Job } from "bullmq";
import { OffpageDraftPayload } from "@abw/shared";
import { prisma } from "../lib/prisma.js";
import { chatJson } from "../lib/openrouter.js";

/**
 * Draft the copy for one off-page task (Reddit answer, directory listing,
 * outreach email...). Deterministic inputs: the task's evidence + the
 * company profile. Output lands on OffPageTask.draft for copy-paste.
 */
export async function offpageDraft(job: Job) {
  const { taskId } = OffpageDraftPayload.parse(job.data);
  const task = await prisma.offPageTask.findUniqueOrThrow({ where: { id: taskId } });
  const company = await prisma.company.findUniqueOrThrow({ where: { id: task.companyId } });
  const profile = (company.profile ?? {}) as any;
  const evidence = (task.evidence ?? {}) as any;

  const kind = /reddit/i.test(task.source) ? "reddit_comment"
    : /clutch|cloudtango|directory|listing/i.test(task.source) ? "directory_listing"
    : "outreach_email";

  const draft = await chatJson<any>(
    [
      {
        role: "system",
        content:
          "You draft authentic off-page content for a real company. Never invent facts, clients, or numbers not provided. " +
          "Reddit content must read like a helpful practitioner, NEVER like marketing — disclose affiliation naturally ('I work at an MSP'), " +
          "lead with genuinely useful specifics, mention the company at most once. Directory listings are factual and complete. " +
          "Outreach emails are short, specific, and human.",
      },
      {
        role: "user",
        content:
          `TASK: ${task.action}\nSOURCE: ${task.source}\nWHY (live evidence): ${JSON.stringify(evidence).slice(0, 1500)}\n\n` +
          `COMPANY: ${company.name} (${company.url})\nPROFILE: ${JSON.stringify(profile).slice(0, 2500)}\n\n` +
          `Draft as ${kind}. Return JSON: {"format":"${kind}","subjectOrTitle":"...","body":"the full copy, ready to paste",` +
          `"tips":["1-3 short pointers for the human posting this (account age, subreddit rules, where to submit...)"]}`,
      },
    ],
    { companyId: company.id, maxTokens: 2000 },
  );

  await prisma.offPageTask.update({
    where: { id: taskId },
    data: { draft: { ...draft, draftedAt: new Date().toISOString() }, status: task.status === "open" ? "in_progress" : task.status },
  });
  console.log(`[offpage-draft] drafted ${kind} for ${task.source}`);
  return { status: "ok", taskId, format: draft.format };
}
