import { Logger } from 'pino';
import { BaseError } from './errors';

/**
 * Request metrics interface
 */
export interface RequestMetrics {
  readonly path: string;
  readonly method: string;
  readonly startTime: number;
  readonly duration: number;
  readonly status: number;
  readonly success: boolean;
  readonly errorCode?: string;
  readonly requestId?: string;
}

/**
 * Performance thresholds in milliseconds
 */
export const PERFORMANCE_THRESHOLDS = {
  WARN: 1000, // 1 second
  ERROR: 3000, // 3 seconds
  CRITICAL: 5000, // 5 seconds
} as const;

/**
 * Tracks API request metrics
 */
export function trackRequestMetrics(metrics: RequestMetrics, logger: Logger): void {
  const { path, method, duration, status, success, errorCode, requestId } = metrics;

  const logData = {
    path,
    method,
    duration: `${duration}ms`,
    status,
    success,
    ...(errorCode && { errorCode }),
    ...(requestId && { requestId }),
  };

  // Log based on performance thresholds
  if (duration >= PERFORMANCE_THRESHOLDS.CRITICAL) {
    logger.error({ ...logData, severity: 'CRITICAL' }, 'Critical request latency');
  } else if (duration >= PERFORMANCE_THRESHOLDS.ERROR) {
    logger.error({ ...logData, severity: 'ERROR' }, 'High request latency');
  } else if (duration >= PERFORMANCE_THRESHOLDS.WARN) {
    logger.warn({ ...logData, severity: 'WARN' }, 'Slow request');
  } else if (!success) {
    logger.error(logData, 'Request failed');
  } else {
    logger.info(logData, 'Request completed');
  }
}

/**
 * Creates a monitoring context for request timing
 */
export function createRequestMonitor() {
  const startTime = Date.now();

  return {
    /**
     * Ends the monitoring and returns metrics
     */
    end(
      path: string,
      method: string,
      result: { status: number; error?: BaseError },
    ): RequestMetrics {
      const duration = Date.now() - startTime;
      const { status, error } = result;

      return {
        path,
        method,
        startTime,
        duration,
        status,
        success: !error,
        ...(error && { errorCode: error.code }),
      };
    },
  };
}

/**
 * Middleware for monitoring request performance
 */
export function withRequestMonitoring<T>(
  fn: () => Promise<T>,
  path: string,
  method: string,
  logger: Logger,
): Promise<T> {
  const monitor = createRequestMonitor();

  return fn()
    .then((result) => {
      const metrics = monitor.end(path, method, { status: 200 });
      trackRequestMetrics(metrics, logger);
      return result;
    })
    .catch((error: BaseError) => {
      const metrics = monitor.end(path, method, {
        status: error.httpStatus ?? 500,
        error,
      });
      trackRequestMetrics(metrics, logger);
      throw error;
    });
}

/**
 * Tracks memory usage metrics
 */
export function trackMemoryUsage(logger: Logger): void {
  const usage = process.memoryUsage();

  logger.info(
    {
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`,
    },
    'Memory usage stats',
  );
}

/**
 * Creates periodic memory usage monitoring
 */
export function startMemoryMonitoring(
  logger: Logger,
  interval = 5 * 60 * 1000, // 5 minutes
): () => void {
  const timer = setInterval(() => trackMemoryUsage(logger), interval);
  return () => clearInterval(timer);
}
