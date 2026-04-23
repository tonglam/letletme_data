import { logJobError, logJobInfo } from './logger';
import { runWithJobLogContext } from './job-log-context';
import { formatUtc8Timestamp } from './timezone';

type JobRunType = 'cron' | 'queue';
type JobRunStatus = 'started' | 'success' | 'failed';

export interface JobRunContext {
  jobType: JobRunType;
  jobName: string;
  queueName?: string;
  jobId?: string | number;
  eventId?: number;
  tournamentId?: number;
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
  // Intentionally silent to keep job logs concise:
  // lifecycle now tracks start/end + success/fail only.
  void context;
  void meta;
}

export async function runTrackedJob<T>(
  context: JobRunContext,
  runner: () => Promise<T>,
  _meta?: JobRunMeta,
): Promise<T> {
  return runWithJobLogContext(context, async () => {
    const startedAtMs = Date.now();
    const startedAtUtc8 = formatUtc8Timestamp(new Date(startedAtMs));

    logJobInfo('Job lifecycle', {
      ...getBasePayload(context, 'started'),
      startedAtUtc8,
    });

    try {
      const result = await runner();
      const finishedAtMs = Date.now();

      logJobInfo('Job lifecycle', {
        ...getBasePayload(context, 'success'),
        startedAtUtc8,
        finishedAtUtc8: formatUtc8Timestamp(new Date(finishedAtMs)),
        durationMs: finishedAtMs - startedAtMs,
      });

      return result;
    } catch (error) {
      const finishedAtMs = Date.now();

      logJobError('Job lifecycle', error, {
        ...getBasePayload(context, 'failed'),
        startedAtUtc8,
        finishedAtUtc8: formatUtc8Timestamp(new Date(finishedAtMs)),
        durationMs: finishedAtMs - startedAtMs,
      });

      throw error;
    }
  });
}

export async function executeTrackedCron(
  jobName: string,
  runner: () => Promise<void>,
  meta?: JobRunMeta,
) {
  const jobId = `${jobName}-${Date.now()}`;
  const context: JobRunContext = {
    jobType: 'cron',
    jobName,
    jobId,
    source: 'cron',
  };

  logJobTriggered(context, meta);
  await runTrackedJob(context, runner, meta);
}
