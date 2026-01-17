import pino from 'pino';
import { join } from 'path';

const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

// Determine logs directory path (root level)
const logsDir = join(process.cwd(), 'logs');

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
    timestamp: pino.stdTimeFunctions.isoTime,
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
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            }
          : {
              destination: 1, // stdout
            },
      },
      // Combined log file (all levels)
      {
        target: 'pino-roll',
        level: logLevel,
        options: {
          file: join(logsDir, 'combined.log'),
          frequency: 'daily',
          size: '10m', // max 10MB per file
          limit: {
            count: 14, // keep 14 days of logs
          },
          mkdir: true,
        },
      },
      // Error log file (errors only)
      {
        target: 'pino-roll',
        level: 'error',
        options: {
          file: join(logsDir, 'error.log'),
          frequency: 'daily',
          size: '10m',
          limit: {
            count: 14,
          },
          mkdir: true,
        },
      },
    ],
  }),
);

// Logger helpers
export const logInfo = (message: string, data?: object) => {
  logger.info(data, message);
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  logger.error({ ...data, error }, message);
};

export const logDebug = (message: string, data?: object) => {
  logger.debug(data, message);
};

export const logWarn = (message: string, data?: object) => {
  logger.warn(data, message);
};
