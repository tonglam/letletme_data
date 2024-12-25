import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import pino from 'pino';
import { formatLocalTime } from '../../../utils/date';
import {
  JobMetricsData,
  MonitorConfig,
  MonitorDependencies,
  MonitorOperations,
  MutableJobMetrics,
  QueueEventData,
  QueueEventEmitter,
  QueueMetrics,
} from '../types';

// Configuration Constants
const DEFAULT_CONFIG: MonitorConfig = {
  metricsInterval: 60000, // 1 minute
  historySize: 1440, // 24 hours
};

// Logging Constants
const LOG_CONFIG = {
  DEFAULT_LEVEL: 'debug',
  PROD_LEVEL: 'info',
  FILE_PATH: './logs/queue-monitor.log',
} as const;

// Time Constants
const TIME_CONSTANTS = {
  MINUTE_IN_MS: 60000,
  ZERO_MS: 0,
} as const;

// Event Types
const EVENT_TYPES = {
  MONITOR_STARTED: 'monitor_started',
  MONITOR_STOPPED: 'monitor_stopped',
  JOB_ACTIVE: 'job_active',
  JOB_COMPLETED: 'job_completed',
  JOB_FAILED: 'job_failed',
  JOB_PROGRESS: 'job_progress',
  METRICS_COLLECTED: 'metrics_collected',
  METRICS_ERROR: 'metrics_collection_error',
} as const;

// Log Messages
const LOG_MESSAGES = {
  MONITOR_STARTED: 'Queue monitoring started',
  MONITOR_STOPPED: 'Queue monitoring stopped',
  JOB_COMPLETED: 'Job completed successfully',
  JOB_FAILED: 'Job failed',
  JOB_PROGRESS: 'Job progress updated',
  METRICS_COLLECTED: 'Queue metrics collected',
  METRICS_ERROR: 'Error collecting queue metrics',
} as const;

// Ensure logs directory exists
import { mkdirSync } from 'fs';
try {
  mkdirSync('./logs', { recursive: true });
} catch (error) {
  // Directory already exists
}

// Create a dedicated logger for queue monitoring
const monitorLogger = pino(
  {
    level:
      process.env.LOG_LEVEL ||
      (process.env.NODE_ENV === 'production' ? LOG_CONFIG.PROD_LEVEL : LOG_CONFIG.DEFAULT_LEVEL),
    timestamp: () => `,"time":"${formatLocalTime(new Date())}"`,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
      bindings: () => ({}),
      log: (object: { event?: string; [key: string]: unknown }) => {
        const { event, ...rest } = object;
        return {
          type: event,
          ...rest,
        };
      },
    },
  },
  pino.destination({
    dest: LOG_CONFIG.FILE_PATH,
    sync: true,
    mkdir: true,
  }),
);

/**
 * Creates a monitor adapter
 */
export const createMonitorAdapter = ({
  queue,
  events,
  logger,
  config = DEFAULT_CONFIG,
}: MonitorDependencies): MonitorOperations => {
  let metricsInterval: ReturnType<typeof setInterval> | null = null;
  const metricsHistory: QueueMetrics[] = [];
  const jobMetrics = new Map<string, MutableJobMetrics>();
  const queueEvents = events as unknown as QueueEventEmitter;

  const setupEventListeners = (): void => {
    queueEvents.on('active', ({ jobId, type, timestamp }: QueueEventData['active']) => {
      jobMetrics.set(jobId, {
        jobId,
        type,
        status: 'active',
        duration: TIME_CONSTANTS.ZERO_MS,
        progress: TIME_CONSTANTS.ZERO_MS,
        attempts: 0,
        timestamp,
      });

      monitorLogger.info({
        event: EVENT_TYPES.JOB_ACTIVE,
        jobId,
        queueName: queue.name,
        type,
        timestamp: formatLocalTime(timestamp),
      });
    });

    queueEvents.on('completed', ({ jobId }: QueueEventData['completed']) =>
      pipe(
        O.fromNullable(jobMetrics.get(jobId)),
        O.map((metrics) => {
          metrics.status = 'completed';
          metrics.duration = Date.now() - metrics.timestamp.getTime();

          monitorLogger.info({
            event: EVENT_TYPES.JOB_COMPLETED,
            jobId,
            queueName: queue.name,
            type: metrics.type,
            duration: `${metrics.duration}ms`,
            attempts: metrics.attempts,
            timestamp: formatLocalTime(new Date()),
          });

          logger.info(
            {
              jobId,
              queueName: queue.name,
              type: metrics.type,
              duration: `${metrics.duration}ms`,
              attempts: metrics.attempts,
            },
            LOG_MESSAGES.JOB_COMPLETED,
            { timestamp: Date.now() },
          );
        }),
      ),
    );

    queueEvents.on('failed', ({ jobId, failedReason }: QueueEventData['failed']) =>
      pipe(
        O.fromNullable(jobMetrics.get(jobId)),
        O.map((metrics) => {
          metrics.status = 'failed';
          metrics.duration = Date.now() - metrics.timestamp.getTime();

          monitorLogger.error({
            event: EVENT_TYPES.JOB_FAILED,
            jobId,
            queueName: queue.name,
            type: metrics.type,
            duration: `${metrics.duration}ms`,
            attempts: metrics.attempts,
            reason: failedReason,
            timestamp: formatLocalTime(new Date()),
          });

          logger.error(
            {
              jobId,
              queueName: queue.name,
              type: metrics.type,
              duration: `${metrics.duration}ms`,
              attempts: metrics.attempts,
              reason: failedReason,
            },
            LOG_MESSAGES.JOB_FAILED,
            { timestamp: Date.now() },
          );
        }),
      ),
    );

    queueEvents.on('progress', ({ jobId, data }: QueueEventData['progress']) =>
      pipe(
        O.fromNullable(jobMetrics.get(jobId)),
        O.map((metrics) => {
          metrics.progress = Number(data);

          monitorLogger.debug({
            event: EVENT_TYPES.JOB_PROGRESS,
            jobId,
            queueName: queue.name,
            type: metrics.type,
            progress: `${metrics.progress}%`,
            timestamp: formatLocalTime(new Date()),
          });

          logger.debug(
            {
              jobId,
              queueName: queue.name,
              type: metrics.type,
              progress: `${metrics.progress}%`,
            },
            LOG_MESSAGES.JOB_PROGRESS,
            { timestamp: Date.now() },
          );
        }),
      ),
    );
  };

  const calculateAverageProcessingTime = (): number =>
    pipe(
      Array.from(jobMetrics.values()),
      (metrics) => metrics.filter((m) => m.status === 'completed'),
      (completed) =>
        completed.length === 0
          ? TIME_CONSTANTS.ZERO_MS
          : completed.reduce((sum, job) => sum + job.duration, 0) / completed.length,
    );

  const calculateThroughput = (currentTime: number): number =>
    pipe(
      Array.from(jobMetrics.values()),
      (metrics) =>
        metrics.filter(
          (m) =>
            m.status === 'completed' &&
            m.timestamp.getTime() > currentTime - TIME_CONSTANTS.MINUTE_IN_MS,
        ),
      (recent) => recent.length,
    );

  const collectMetrics = async (): Promise<void> => {
    try {
      const counts = await queue.getJobCounts();
      const currentTime = Date.now();
      const completedCount = counts.completed || 0;
      const failedCount = counts.failed || 0;
      const totalJobs = Object.values(counts).reduce(
        (sum: number, count: number) => sum + count,
        0,
      );

      const metrics: QueueMetrics = {
        activeJobs: counts.active || 0,
        waitingJobs: counts.waiting || 0,
        completedJobs: completedCount,
        failedJobs: failedCount,
        delayedJobs: counts.delayed || 0,
        processingTime: calculateAverageProcessingTime(),
        errorRate: totalJobs > 0 ? (failedCount / totalJobs) * 100 : 0,
        throughput: calculateThroughput(currentTime),
      };

      metricsHistory.push(metrics);
      if (metricsHistory.length > config.historySize) {
        metricsHistory.shift();
      }

      monitorLogger.info({
        event: EVENT_TYPES.METRICS_COLLECTED,
        queueName: queue.name,
        metrics: {
          ...metrics,
          processingTime: `${metrics.processingTime}ms`,
          errorRate: `${metrics.errorRate.toFixed(2)}%`,
          throughput: `${metrics.throughput} jobs/minute`,
        },
        timestamp: formatLocalTime(new Date(currentTime)),
      });

      logger.info(
        {
          queueName: queue.name,
          metrics: {
            ...metrics,
            processingTime: `${metrics.processingTime}ms`,
            errorRate: `${metrics.errorRate.toFixed(2)}%`,
            throughput: `${metrics.throughput} jobs/minute`,
          },
        },
        LOG_MESSAGES.METRICS_COLLECTED,
        { timestamp: currentTime },
      );
    } catch (error) {
      monitorLogger.error({
        event: EVENT_TYPES.METRICS_ERROR,
        queueName: queue.name,
        error,
        timestamp: formatLocalTime(new Date()),
      });

      logger.error({ error, queueName: queue.name }, LOG_MESSAGES.METRICS_ERROR, {
        timestamp: Date.now(),
      });
    }
  };

  const toJobMetricsData = (metrics: MutableJobMetrics): JobMetricsData => ({
    ...metrics,
  });

  setupEventListeners();

  return {
    start: () =>
      TE.tryCatch(
        () => {
          metricsInterval = setInterval(() => void collectMetrics(), config.metricsInterval);

          monitorLogger.info({
            event: EVENT_TYPES.MONITOR_STARTED,
            queueName: queue.name,
            timestamp: formatLocalTime(new Date()),
          });

          logger.info({ queueName: queue.name }, LOG_MESSAGES.MONITOR_STARTED, {
            timestamp: Date.now(),
          });
          return Promise.resolve();
        },
        (error) => error as Error,
      ),

    stop: () =>
      TE.tryCatch(
        () => {
          if (metricsInterval) {
            clearInterval(metricsInterval);
            metricsInterval = null;
          }

          monitorLogger.info({
            event: EVENT_TYPES.MONITOR_STOPPED,
            queueName: queue.name,
            timestamp: formatLocalTime(new Date()),
          });

          logger.info({ queueName: queue.name }, LOG_MESSAGES.MONITOR_STOPPED, {
            timestamp: Date.now(),
          });
          return Promise.resolve();
        },
        (error) => error as Error,
      ),

    getMetrics: () =>
      TE.tryCatch(
        () => Promise.resolve(metricsHistory[metricsHistory.length - 1]),
        (error) => error as Error,
      ),

    getJobMetrics: (jobId: string) =>
      TE.tryCatch(
        () =>
          Promise.resolve(
            pipe(O.fromNullable(jobMetrics.get(jobId)), O.map(toJobMetricsData), O.toNullable),
          ),
        (error) => error as Error,
      ),
  };
};
