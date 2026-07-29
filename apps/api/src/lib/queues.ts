import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUES, type QueueName } from "@abw/shared";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:63790", {
  maxRetriesPerRequest: null,
});

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queues.set(name, q);
  }
  return q;
}

export { QUEUES };
export const redis = connection;
