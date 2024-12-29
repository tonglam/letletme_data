import * as path from 'path';
import { Logger, pino } from 'pino';
import { formatLocalTime } from '../../utils/date.util';

// Available log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// Logger configuration interface
export interface LoggerConfig {
  /** Logger name identifier */
  name: string;
  /** Logging level */
  level: LogLevel;
  /** Path to log file */
  filepath: string;
}

// Creates base configuration for pino logger
const createBaseConfig = (config: LoggerConfig) => ({
  level: config.level,
  timestamp: () => `,"time":"${formatLocalTime(new Date())}"`,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({}),
  },
});

// Creates a configured pino logger instance
export const createLogger = (config: LoggerConfig): Logger => {
  const transport = pino.transport({
    target: 'pino/file',
    options: {
      destination: path.join(config.filepath, `${config.name}.log`),
      mkdir: true,
      sync: false,
    },
  });

  return pino(createBaseConfig(config), transport);
};

// Default logger configurations
export const LOG_CONFIG = {
  path: process.env.LOG_PATH || 'logs',
  level:
    (process.env.LOG_LEVEL as LogLevel) ||
    (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  loggers: {
    api: { name: 'api' },
    fpl: { name: 'fpl' },
    queue: { name: 'queue' },
    workflow: { name: 'workflow' },
  },
} as const;
