import { logError, logInfo } from './logger';
import { formatUtc8Timestamp } from './timezone';

type JobRunType = 'cron' | 'queue';
type JobRunStatus = 'triggered' | 'started' | 'success' | 'failed';

export interface JobRunContext {
  jobType: JobRunType;
  jobName: string;
  queueName?: string;
  jobId?: string | number;
  eventId?: number;
  source?: string;
  attempt?: number;
}

type JobRunMeta = Record<string, unknown>;

function getBasePayload(context: JobRunContext, status: JobRunStatus): JobRunMeta {
  return {
    status,
    jobType: context.jobType,
    jobName: context.jobName,
    queueName: context.queueName,
    jobId: context.jobId,
    eventId: context.eventId,
    source: context.source,
    attempt: context.attempt,
  };
}

export function logJobTriggered(context: JobRunContext, meta?: JobRunMeta) {
  logInfo('Job lifecycle', {
    ...getBasePayload(context, 'triggered'),
    triggeredAtUtc8: formatUtc8Timestamp(),
    ...meta,
  });
}

export async function runTrackedJob<T>(
  context: JobRunContext,
  runner: () => Promise<T>,
  meta?: JobRunMeta,
): Promise<T> {
  const startedAtMs = Date.now();
  const startedAtUtc8 = formatUtc8Timestamp(new Date(startedAtMs));

  logInfo('Job lifecycle', {
    ...getBasePayload(context, 'started'),
    startedAtUtc8,
    ...meta,
  });

  try {
    const result = await runner();
    const finishedAtMs = Date.now();

    logInfo('Job lifecycle', {
      ...getBasePayload(context, 'success'),
      startedAtUtc8,
      finishedAtUtc8: formatUtc8Timestamp(new Date(finishedAtMs)),
      durationMs: finishedAtMs - startedAtMs,
      ...meta,
    });

    return result;
  } catch (error) {
    const finishedAtMs = Date.now();

    logError('Job lifecycle', error, {
      ...getBasePayload(context, 'failed'),
      startedAtUtc8,
      finishedAtUtc8: formatUtc8Timestamp(new Date(finishedAtMs)),
      durationMs: finishedAtMs - startedAtMs,
      ...meta,
    });

    throw error;
  }
}
