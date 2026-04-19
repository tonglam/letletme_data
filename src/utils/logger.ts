import { appendFileSync, mkdirSync } from 'fs';
import pino from 'pino';
import { join } from 'path';
import { formatUtc8Timestamp } from './timezone';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

// Determine logs directory path (root level)
const logsDir = join(process.cwd(), 'logs');
const combinedLogPath = join(logsDir, 'combined.log');
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

function writeFileLog(level: LogLevel, message: string, payload?: object) {
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

    appendFileSync(combinedLogPath, `${line}\n`);
    if (level === 'error') {
      appendFileSync(errorLogPath, `${line}\n`);
    }
  } catch {
    // Swallow file-write errors so app logging never crashes runtime.
  }
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

// Logger helpers
export const logInfo = (message: string, data?: object) => {
  logger.info(data, message);
  writeFileLog('info', message, data);
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  const payload = { ...data, error };
  logger.error(payload, message);
  writeFileLog('error', message, payload);
};

export const logDebug = (message: string, data?: object) => {
  logger.debug(data, message);
  writeFileLog('debug', message, data);
};

export const logWarn = (message: string, data?: object) => {
  logger.warn(data, message);
  writeFileLog('warn', message, data);
};
