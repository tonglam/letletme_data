import { queueRedisSingleton } from '../queues/redis';

const MY_FPL_REFRESH_TRACKER_TTL_SECONDS = 2 * 60 * 60;

type MyFplRefreshJobReference = Readonly<{
  queueName: string;
  jobId: string;
}>;

const trackerKey = (runId: string): string => `llm:queue:coordination:my-fpl-refresh:${runId}:jobs`;

const encodeReference = (reference: MyFplRefreshJobReference): string => JSON.stringify(reference);

const decodeReference = (value: string): MyFplRefreshJobReference | null => {
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
 * Register a BullMQ job before its worker can complete. Snapshot coordinators
 * wait on this exact set rather than scanning queue states independently,
 * which closes the gap where a cascade child is enqueued between two scans.
 */
export async function trackMyFplRefreshJob(
  runId: string | undefined,
  queueName: string,
  jobId: string | number | undefined,
): Promise<void> {
  if (!runId || jobId === undefined) return;
  const redis = await queueRedisSingleton.getClient();
  const key = trackerKey(runId);
  await redis.sadd(key, encodeReference({ queueName, jobId: String(jobId) }));
  await redis.expire(key, MY_FPL_REFRESH_TRACKER_TTL_SECONDS);
}

export async function listMyFplRefreshJobs(
  runId: string,
): Promise<readonly MyFplRefreshJobReference[]> {
  const redis = await queueRedisSingleton.getClient();
  const values = await redis.smembers(trackerKey(runId));
  return values.flatMap((value) => {
    const reference = decodeReference(value);
    return reference ? [reference] : [];
  });
}

export async function clearMyFplRefreshJobs(runId: string): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.del(trackerKey(runId));
}
