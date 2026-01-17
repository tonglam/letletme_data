import type { Queue, QueueEvents } from 'bullmq';

import { logError, logInfo, logWarn } from './logger';

type QueueCounts = Record<string, number>;

interface QueueMonitorOptions {
  queue: Queue;
  queueEvents: QueueEvents;
  queueName?: string;
  pollIntervalMs?: number;
}

const defaultPollIntervalMs = 60_000;

function toError(reason?: string) {
  return reason ? new Error(reason) : undefined;
}

async function resolveJobName(queue: Queue, jobId?: string) {
  if (!jobId) {
    return undefined;
  }

  try {
    const job = await queue.getJob(jobId);
    return job?.name;
  } catch (error) {
    logError('Queue monitor failed to load job', error, { queue: queue.name, jobId });
    return undefined;
  }
}

function summarizeCounts(counts: QueueCounts, previous?: QueueCounts) {
  if (!previous) {
    return {};
  }

  return {
    waitingDelta: counts.waiting - (previous.waiting ?? 0),
    activeDelta: counts.active - (previous.active ?? 0),
    delayedDelta: counts.delayed - (previous.delayed ?? 0),
    failedDelta: counts.failed - (previous.failed ?? 0),
  };
}

export function startQueueMonitor(options: QueueMonitorOptions) {
  const { queue, queueEvents } = options;
  const queueName = options.queueName ?? queue.name;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  let pollInterval: NodeJS.Timeout | null = null;
  let lastCounts: QueueCounts | null = null;

  const logCounts = async (context: string) => {
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      const deltas = summarizeCounts(counts, lastCounts ?? undefined);

      logInfo('Queue job counts', {
        queue: queueName,
        context,
        counts,
        ...deltas,
      });

      if (lastCounts && deltas.failedDelta > 0) {
        logWarn('Queue failed jobs increased', {
          queue: queueName,
          failedDelta: deltas.failedDelta,
          failedCount: counts.failed,
        });
      }

      lastCounts = counts;
    } catch (error) {
      logError('Queue job count fetch failed', error, { queue: queueName });
    }
  };

  queueEvents.on('failed', ({ jobId, failedReason, prev }) => {
    void resolveJobName(queue, jobId).then((jobName) => {
      logError('Queue event failed', toError(failedReason), {
        queue: queueName,
        jobId,
        jobName,
        previous: prev,
        failedReason,
      });
    });
  });

  queueEvents.on('completed', ({ jobId, prev }) => {
    void resolveJobName(queue, jobId).then((jobName) => {
      logInfo('Queue event completed', {
        queue: queueName,
        jobId,
        jobName,
        previous: prev,
      });
    });
  });

  queueEvents.on('stalled', ({ jobId }) => {
    void resolveJobName(queue, jobId).then((jobName) => {
      logError('Queue event stalled', undefined, { queue: queueName, jobId, jobName });
    });
  });

  queueEvents.on('error', (error) => {
    logError('Queue events error', error, { queue: queueName });
  });

  queueEvents
    .waitUntilReady()
    .then(() => {
      logInfo('Queue events ready', { queue: queueName });
      void logCounts('startup');
      pollInterval = setInterval(() => {
        void logCounts('interval');
      }, pollIntervalMs);
    })
    .catch((error) => logError('Queue events init failed', error, { queue: queueName }));

  return {
    stop() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    },
  };
}
