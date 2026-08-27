import { queueRedisSingleton } from '../queues/redis';

const QUEUE_RUN_TRACKER_TTL_SECONDS = 2 * 60 * 60;

export type QueueRunJobReference = Readonly<{
  queueName: string;
  jobId: string;
}>;

const trackerKey = (runId: string): string => `llm:queue:coordination:run:${runId}:jobs`;

const isHermeticUnitTest = (): boolean =>
  process.env.NODE_ENV === 'test' && process.env.RUN_INTEGRATION !== '1';

const encodeReference = (reference: QueueRunJobReference): string => JSON.stringify(reference);

const decodeReference = (value: string): QueueRunJobReference | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.queueName !== 'string' || typeof candidate.jobId !== 'string') return null;
    return { queueName: candidate.queueName, jobId: candidate.jobId };
  } catch {
    return null;
  }
};

/**
 * Register a BullMQ job before its worker can complete. Coordinators wait on
 * this exact set rather than scanning queue states independently, which closes
 * the gap where a cascade child is enqueued between two scans.
 */
export async function trackQueueRunJob(
  runId: string | undefined,
  queueName: string,
  jobId: string | number | undefined,
): Promise<void> {
  if (!runId || jobId === undefined) return;
  if (isHermeticUnitTest()) return;
  const redis = await queueRedisSingleton.getClient();
  const key = trackerKey(runId);
  await redis.sadd(key, encodeReference({ queueName, jobId: String(jobId) }));
  await redis.expire(key, QUEUE_RUN_TRACKER_TTL_SECONDS);
}

export async function listQueueRunJobs(runId: string): Promise<readonly QueueRunJobReference[]> {
  if (isHermeticUnitTest()) return [];
  const redis = await queueRedisSingleton.getClient();
  const values = await redis.smembers(trackerKey(runId));
  return values.flatMap((value) => {
    const reference = decodeReference(value);
    return reference ? [reference] : [];
  });
}

export async function clearQueueRunJobs(runId: string): Promise<void> {
  if (isHermeticUnitTest()) return;
  const redis = await queueRedisSingleton.getClient();
  await redis.del(trackerKey(runId));
}
