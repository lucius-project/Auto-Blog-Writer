import type { FastifyInstance } from "fastify";
import { JOB_PAYLOADS, QUEUES } from "@abw/shared";
import { getQueue } from "../lib/queues.js";

/**
 * Enqueue pipeline jobs. All AI / research / publishing work runs in the
 * worker via BullMQ — never inline in an HTTP request.
 *
 *   POST /api/jobs/research-company  { companyId }
 *   POST /api/jobs/analyze-gaps      { companyId, locationId?, verticalId? }
 *   POST /api/jobs/generate-blog     { companyId, locationId?, verticalId?, gapAnalysisId?, topic? }
 *   POST /api/jobs/publish-blog      { blogPostId, publishTargetId? }
 */
export async function jobRoutes(app: FastifyInstance) {
  const queueNames = Object.values(QUEUES) as string[];

  app.post("/jobs/:queue", async (req, reply) => {
    const { queue } = req.params as { queue: string };
    if (!queueNames.includes(queue)) {
      return reply
        .code(404)
        .send({ error: `unknown queue '${queue}'`, known: queueNames });
    }
    const name = queue as keyof typeof JOB_PAYLOADS;
    const payload = JOB_PAYLOADS[name].parse(req.body ?? {});
    const job = await getQueue(name).add(name, payload);
    return reply.code(202).send({ jobId: job.id, queue: name, payload });
  });
}
