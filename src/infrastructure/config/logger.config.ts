import * as path from 'path';

import { formatLocalTime } from '@app/utils/date.util';
import { Logger, pino } from 'pino';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LoggerConfig {
  name: string;
  level: LogLevel;
  filepath: string;
}

const createBaseConfig = (config: LoggerConfig) => ({
  level: config.level,
  timestamp: () => `,"time":"${formatLocalTime(new Date())}"`,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({}),
  },
});

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

export const LOG_CONFIG = {
  path: process.env.LOG_PATH || 'logs',
  level:
    (process.env.LOG_LEVEL as LogLevel) ||
    (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  loggers: {
    api: { name: 'api' },
    fpl: { name: 'fpl' },
    app: { name: 'app' },
    job: { name: 'job' },
    workflow: { name: 'workflow' },
  },
} as const;
