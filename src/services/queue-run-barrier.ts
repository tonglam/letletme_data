import { QueueEvents } from 'bullmq';

import { dataSyncQueue } from '../queues/data-sync.queue';
import { entrySyncQueue } from '../queues/entry-sync.queue';
import { tournamentSyncQueue } from '../queues/tournament-sync.queue';
import { getQueueConnection } from '../utils/queue';
import { clearQueueRunJobs, listQueueRunJobs } from './queue-run-tracker';

// A full current-season snapshot fans out across every known entry. The
// timeout must cover every continuation and exact failed-ID retry.
export const QUEUE_RUN_WAIT_TIMEOUT_MS = 30 * 60_000;
export const QUEUE_RUN_WAIT_POLL_MS = 2_000;

export type QueuedJobReceipt = Readonly<{ id?: string | number }>;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Wait until every tracked job and every descendant registered by those jobs
 * has settled. Workers register descendants before completing their parent,
 * so the final tracker re-read is the publication barrier.
 */
export async function waitForQueueRunJobs(
  runId: string,
  options: Readonly<{ timeoutMs?: number; pollMs?: number }> = {},
): Promise<void> {
  const queues = [dataSyncQueue, entrySyncQueue, tournamentSyncQueue] as const;
  const queueEvents = new Map(
    queues.map((queue) => [
      queue.name,
      new QueueEvents(queue.name, { connection: getQueueConnection() }),
    ]),
  );
  const deadline = Date.now() + (options.timeoutMs ?? QUEUE_RUN_WAIT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? QUEUE_RUN_WAIT_POLL_MS;
  const completed = new Set<string>();
  let settled = false;
  try {
    while (Date.now() < deadline) {
      const references = await listQueueRunJobs(runId);
      if (references.length === 0) {
        await sleep(pollMs);
        continue;
      }

      const pending: Promise<unknown>[] = [];
      for (const reference of references) {
        const identity = `${reference.queueName}:${reference.jobId}`;
        if (completed.has(identity)) continue;
        const queue = queues.find((candidate) => candidate.name === reference.queueName);
        const events = queueEvents.get(reference.queueName);
        if (!queue || !events) {
          throw new Error(`Queue run ${runId} references unknown queue ${reference.queueName}`);
        }
        const job = await queue.getJob(reference.jobId);
        if (!job) throw new Error(`Queue run ${runId} lost tracked job ${identity}`);
        const state = await job.getState();
        if (state === 'failed') {
          throw new Error(
            `Queue run ${runId} has terminal queue failure ${identity}: ${job.failedReason ?? 'unknown error'}`,
          );
        }
        if (state === 'completed') {
          completed.add(identity);
          continue;
        }
        const remaining = Math.max(1, deadline - Date.now());
        pending.push(job.waitUntilFinished(events, remaining));
      }

      if (pending.length === 0) {
        const finalReferences = await listQueueRunJobs(runId);
        if (
          finalReferences.every((reference) =>
            completed.has(`${reference.queueName}:${reference.jobId}`),
          )
        ) {
          settled = true;
          return;
        }
        continue;
      }
      await Promise.all(pending);
    }
    throw new Error(`Queue run ${runId} did not settle before the coordinator timeout`);
  } finally {
    await Promise.all([...queueEvents.values()].map((events) => events.close()));
    if (settled) await clearQueueRunJobs(runId);
  }
}

/**
 * Enqueue one ordered phase, then wait for all of its continuations and exact
 * failed-ID retries before allowing the coordinator to enqueue the next phase.
 */
export async function runQueueRunPhase(
  runId: string,
  jobs: readonly Promise<QueuedJobReceipt>[],
): Promise<readonly QueuedJobReceipt[]> {
  const queuedJobs = await Promise.all(jobs);
  await waitForQueueRunJobs(runId);
  return queuedJobs;
}
