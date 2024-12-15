import pino, { Logger, LoggerOptions } from 'pino';

// Logger configuration type
export type LoggerConfig = Readonly<
  LoggerOptions & {
    redactPaths: readonly string[];
  }
>;

// Default logger configuration
const DEFAULT_CONFIG: LoggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redactPaths: ['password', 'token', 'secret', 'credentials', 'apiKey'],
  redact: {
    paths: ['password', 'token', 'secret', 'credentials', 'apiKey'],
    remove: true,
  },
} as const;

// Base logger instance
const baseLogger = pino(DEFAULT_CONFIG);

// Logger context types with strict typing
export type LogContext = Readonly<{
  timestamp?: number;
  [key: string]: unknown;
}>;

export type ComponentContext = LogContext &
  Readonly<{
    component: string;
    version?: string;
  }>;

export type JobContext = ComponentContext &
  Readonly<{
    jobName?: string;
    jobId?: string;
    duration?: number;
    attempt?: number;
    error?: Error | string;
  }>;

export type QueueContext = ComponentContext &
  Readonly<{
    queueName: string;
    error?: Error | string;
    size?: number;
  }>;

export type WorkerContext = ComponentContext &
  Readonly<{
    workerId: string;
    error?: Error | string;
    status?: 'idle' | 'busy' | 'error';
  }>;

// Error handling utility with memoization
const errorCache = new WeakMap<Error, { message: string; stack?: string }>();

const formatError = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) {
    const cached = errorCache.get(error);
    if (cached) return cached;

    const formatted = {
      message: error.message,
      stack: error.stack,
    };
    errorCache.set(error, formatted);
    return formatted;
  }
  return { message: String(error) };
};

// Pure logging functions with type safety and performance optimization
const createPureLogger =
  (level: pino.LevelWithSilent) =>
  <T extends LogContext>(context: T, message: string) =>
  () => {
    const timestamp = Date.now();
    const logContext = { ...context, timestamp };

    if ('error' in context && context.error) {
      const { error, ...rest } = logContext;
      baseLogger[level]({ ...rest, ...formatError(error) }, message);
      return;
    }
    baseLogger[level](logContext, message);
  };

// Exported pure loggers
export const infoLogger = createPureLogger('info');
export const warnLogger = createPureLogger('warn');
export const errorLogger = createPureLogger('error');
export const debugLogger = createPureLogger('debug');
export const traceLogger = createPureLogger('trace');

// Contextual logger creation with type safety and validation
export const createLogger = (component: string, version?: string): Logger => {
  if (!component) {
    throw new Error('Component name is required for logger creation');
  }
  return baseLogger.child({ component, version });
};

// Component-specific loggers with validation and type inference
export const createJobLogger = (context: Omit<JobContext, 'component'>): Logger => {
  if (!context.jobName && !context.jobId) {
    throw new Error('Either jobName or jobId is required for job logger');
  }
  return baseLogger.child({ ...context, component: 'job' });
};

export const createQueueLogger = (queueName: string, size?: number): Logger => {
  if (!queueName) {
    throw new Error('Queue name is required for queue logger');
  }
  const context: Omit<QueueContext, 'component'> = { queueName, size };
  return baseLogger.child({ ...context, component: 'queue' });
};

export const createWorkerLogger = (
  workerId: string,
  status: WorkerContext['status'] = 'idle',
): Logger => {
  if (!workerId) {
    throw new Error('Worker ID is required for worker logger');
  }
  return baseLogger.child({ workerId, component: 'worker', status });
};

// Default logger instance
export const logger = baseLogger;
