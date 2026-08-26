import pino from 'pino';

import { getJobLogContext } from './job-log-context';
import { formatUtc8Timestamp } from './timezone';

/**
 * Production detection must survive bundling: `bun build` can inline
 * `process.env.NODE_ENV` at compile time. Prefer an explicit production path
 * and never require `pino-pretty` (devDependency) at runtime.
 */
function isProductionRuntime(): boolean {
  // Read via dynamic key so some bundlers leave this as a real env lookup.
  const nodeEnv = process.env['NODE_ENV'];
  return nodeEnv === 'production';
}

const logLevel = process.env.LOG_LEVEL || 'info';

const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_ERROR_STACK_LENGTH = 500;
const MAX_ERROR_CAUSE_DEPTH = 2;
const REDACTED_LOG_VALUE = '[REDACTED]';
const SENSITIVE_LOG_KEY_PATTERN =
  /^(?:entry[_-]?ids?|scopes?|scope[_-]?key|token|secret|password|api[_-]?key|authorization|headers?|sql|statement|query|params?|parameters|payload|body)$/i;
const ENTRY_ID_PATH_PATTERN = /(\/entry\/)(\d+)/gi;
const ENTRY_ID_LABEL_PATTERN = /(\bentry(?:[_ -]?ids?)?\s*(?:[:=#-]\s*|\s+))\d+/gi;

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

/** Keep operational logs useful while preventing entry identifiers from being
 * copied into stdout, which is retained and forwarded to third-party sinks. */
function redactSensitiveText(value: string): string {
  return value
    .replace(ENTRY_ID_PATH_PATTERN, `$1${REDACTED_LOG_VALUE}`)
    .replace(ENTRY_ID_LABEL_PATTERN, `$1${REDACTED_LOG_VALUE}`);
}

function sanitizeLogValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_LOG_KEY_PATTERN.test(key)) return REDACTED_LOG_VALUE;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 6) return REDACTED_LOG_VALUE;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, undefined, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeLogValue(childValue, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

function sanitizeLogPayload(data?: object): object | undefined {
  if (data === undefined) return undefined;
  const sanitized = sanitizeLogValue(data);
  return isRecord(sanitized) ? sanitized : undefined;
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
      constraint?: unknown;
      schema?: unknown;
      table?: unknown;
      detail?: unknown;
      hint?: unknown;
    };
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: truncate(error.message, MAX_ERROR_MESSAGE_LENGTH),
    };

    if (error.stack) {
      // Keep only the first, bounded line. Full stacks can include request
      // paths, identifiers, SQL fragments, and other internal details.
      const firstLine = error.stack.split('\n', 1)[0] ?? '';
      serialized.stack = truncate(redactSensitiveText(firstLine), MAX_ERROR_STACK_LENGTH);
    }
    if (errorWithMetadata.code !== undefined) {
      serialized.code = errorWithMetadata.code;
    }
    if (errorWithMetadata.status !== undefined) {
      serialized.status = errorWithMetadata.status;
    }
    for (const field of ['constraint', 'schema', 'table', 'detail', 'hint'] as const) {
      const value = errorWithMetadata[field];
      if (typeof value === 'string') serialized[field] = truncate(value, MAX_ERROR_MESSAGE_LENGTH);
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
        if (
          /^(query|params?|parameters|payload|body|sql|statement|token|secret|password|apiKey)/i.test(
            key,
          )
        ) {
          return [];
        }
        if (typeof value === 'string') {
          return [[key, redactSensitiveText(truncate(value, MAX_ERROR_MESSAGE_LENGTH))]];
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

function createLogger(): pino.Logger {
  // Always JSON in production (and when NODE_ENV is unset in a prod image).
  if (isProductionRuntime()) {
    return pino(loggerOptions);
  }

  // Local/dev: pretty logs when pino-pretty is installed; fall back to JSON.
  try {
    return pino(
      loggerOptions,
      pino.transport({
        target: 'pino-pretty',
        level: logLevel,
        options: {
          colorize: true,
          ignore: 'pid,hostname',
        },
      }),
    );
  } catch {
    return pino(loggerOptions);
  }
}

export const logger = createLogger();

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
  const payload = sanitizeLogPayload(mergeJobContext(data));
  logger.info(payload, message);
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = sanitizeLogPayload(mergeJobContext(data));
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: sanitizeLogValue(serializeError(error), 'error') }),
  };
  logger.error(payload, message);
};

export const logDebug = (message: string, data?: object) => {
  const payload = sanitizeLogPayload(mergeJobContext(data));
  logger.debug(payload, message);
};

export const logWarn = (message: string, data?: object) => {
  const payload = sanitizeLogPayload(mergeJobContext(data));
  logger.warn(payload, message);
};

export const logJobError = (message: string, error?: Error | unknown, data?: object) => {
  const payloadWithContext = sanitizeLogPayload(mergeJobContext(data));
  const payload = {
    ...(payloadWithContext ?? {}),
    ...(error === undefined ? {} : { error: sanitizeLogValue(serializeError(error), 'error') }),
  };
  logger.error(payload, message);
};
