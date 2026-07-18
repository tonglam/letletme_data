import pino from 'pino';

import { getJobLogContext } from './job-log-context';
import { formatUtc8Timestamp } from './timezone';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_ERROR_STACK_LENGTH = 8_000;
const MAX_ERROR_CAUSE_DEPTH = 2;

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function serializeError(error: unknown, depth = 0): unknown {
  if (error instanceof Error) {
    const errorWithMetadata = error as Error & {
      cause?: unknown;
      code?: unknown;
      status?: unknown;
    };
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: truncate(error.message, MAX_ERROR_MESSAGE_LENGTH),
    };

    if (error.stack) {
      serialized.stack = truncate(error.stack, MAX_ERROR_STACK_LENGTH);
    }
    if (errorWithMetadata.code !== undefined) {
      serialized.code = errorWithMetadata.code;
    }
    if (errorWithMetadata.status !== undefined) {
      serialized.status = errorWithMetadata.status;
    }
    if (errorWithMetadata.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.cause = serializeError(errorWithMetadata.cause, depth + 1);
    }

    return serialized;
  }

  if (isRecord(error)) {
    const metadataEntries: Array<[string, string | number | boolean | null]> = Object.entries(error)
      .slice(0, 20)
      .flatMap(([key, value]): Array<[string, string | number | boolean | null]> => {
        if (typeof value === 'string') {
          return [[key, truncate(value, MAX_ERROR_MESSAGE_LENGTH)]];
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          return [[key, value]];
        }
        return [];
      });
    const metadata = Object.fromEntries(metadataEntries);

    return {
      message: truncate(
        typeof error.message === 'string' ? error.message : 'Non-Error object thrown',
        MAX_ERROR_MESSAGE_LENGTH,
      ),
      ...metadata,
    };
  }

  return { message: truncate(String(error), MAX_ERROR_MESSAGE_LENGTH) };
}

/**
 * Structured logger configuration.
 *
 * Development:
 * - Console: pretty formatted output
 * - Output: pretty console logs
 *
 * Production:
 * - Output: JSON on stdout; Docker owns rotation and retention
 */
const loggerOptions: pino.LoggerOptions = {
  level: logLevel,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: () => `,"time":"${formatUtc8Timestamp()}"`,
  redact: {
    paths: ['*.token', '*.secret', '*.password', '*.key', '*.apiKey', 'req.headers["x-api-key"]'],
    censor: '[REDACTED]',
  },
};

export const logger = isDevelopment
  ? pino(
      loggerOptions,
      pino.transport({
        target: 'pino-pretty',
        level: logLevel,
        options: {
          colorize: true,
          ignore: 'pid,hostname',
        },
      }),
    )
  : pino(loggerOptions);

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
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = mergeJobContext(data);
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };
  logger.error(payload, message);
};

export const logDebug = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.debug(payload, message);
};

export const logWarn = (message: string, data?: object) => {
  const payload = mergeJobContext(data);
  logger.warn(payload, message);
};

export const logJobError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = mergeJobContext(data);
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: serializeError(error) }),
  };
  logger.error(payload, message);
};
