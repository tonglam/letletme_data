import * as dotenv from 'dotenv';
import * as path from 'path';
import pino from 'pino';
import { getCurrentSeason } from '../../types/base.type';

// Load environment variables
dotenv.config();

// Application-wide configuration
export const AppConfig = {
  currentSeason: getCurrentSeason(),
  port: process.env.PORT || '3000',
  logLevel: process.env.LOG_LEVEL || 'info',
  logPath: process.env.LOG_PATH || 'logs',
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
} as const;

// Logger instance
export const logger = pino(
  {
    level: AppConfig.logLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
      bindings: () => ({}),
    },
  },
  pino.transport({
    target: 'pino/file',
    options: {
      destination: path.join(AppConfig.logPath, 'app.log'),
      mkdir: true,
      sync: false,
    },
  }),
);
