import { appendFileSync, mkdirSync } from 'fs';
import pino from 'pino';
import { join } from 'path';

import { getJobLogContext } from './job-log-context';
import { formatUtc8Timestamp } from './timezone';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

// Determine logs directory path (root level)
const logsDir = join(process.cwd(), 'logs');
const appLogPath = join(logsDir, 'app.log');
const jobsLogPath = join(logsDir, 'jobs.log');
const errorLogPath = join(logsDir, 'error.log');

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const logLevelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(level: string): LogLevel {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level;
  }
  return 'info';
}

const configuredLogLevel = resolveLogLevel(logLevel);

function shouldWrite(level: LogLevel) {
  return logLevelPriority[level] >= logLevelPriority[configuredLogLevel];
}

function writeFileLog(
  level: LogLevel,
  message: string,
  payload?: object,
  options: { stream?: 'app' | 'jobs' } = {},
) {
  if (!shouldWrite(level)) {
    return;
  }

  try {
    mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({
      time: formatUtc8Timestamp(),
      level,
      message,
      ...(payload ? { payload } : {}),
    });

    const stream = options.stream ?? 'app';
    const destination = stream === 'jobs' ? jobsLogPath : appLogPath;
    appendFileSync(destination, `${line}\n`);
    if (level === 'error') {
      appendFileSync(errorLogPath, `${line}\n`);
    }
  } catch {
    // Swallow file-write errors so app logging never crashes runtime.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      serialized.cause = serializeError(cause);
    }

    for (const key of Object.getOwnPropertyNames(error)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
        continue;
      }
      const value = (error as Record<string, unknown>)[key];
      if (value !== undefined) {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  if (isRecord(error)) {
    return error;
  }

  return { message: String(error) };
}

/**
 * Logger configuration with file and console output
 *
 * Development:
 * - Console: pretty formatted output
 * - Files: combined.log (all), error.log (errors only)
 *
 * Production:
 * - Console: JSON formatted output
 * - Files: combined.log (all), error.log (errors only)
 * - Log rotation: daily, keeps 14 days
 */
export const logger = pino(
  {
    level: logLevel,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: () => `,"time":"${formatUtc8Timestamp()}"`,
  },
  pino.transport({
    targets: [
      // Console output
      {
        target: isDevelopment ? 'pino-pretty' : 'pino/file',
        level: logLevel,
        options: isDevelopment
          ? {
              colorize: true,
              ignore: 'pid,hostname',
            }
          : {
              destination: 1, // stdout
            },
      },
    ],
  }),
);

function mergeJobContext(data?: object): object | undefined {
  const jobContext = getJobLogContext();
  if (!jobContext) {
    return data;
  }

  return {
    ...(data ?? {}),
    ...jobContext,
  };
}

// Logger helpers
export const logInfo = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.info(payload, message);
  writeFileLog('info', message, payload);
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = mergeJobContext(data);
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };
  logger.error(payload, message);
  writeFileLog('error', message, payload);
};

export const logDebug = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.debug(payload, message);
  writeFileLog('debug', message, payload);
};

export const logWarn = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.warn(payload, message);
  writeFileLog('warn', message, payload);
};

export const logJobInfo = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.info(payload, message);
  writeFileLog('info', message, payload, { stream: 'jobs' });
};

export const logJobError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = mergeJobContext(data);
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };
  logger.error(payload, message);
  writeFileLog('error', message, payload, { stream: 'jobs' });
};
