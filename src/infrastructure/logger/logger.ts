import { Logger } from 'pino';
import { LOG_CONFIG, createLogger } from '../../config/logger/logger.config';

// Logger instances cache
const loggerInstances = new Map<string, Logger>();

// Core logger factory function
const getOrCreateLogger = (name: keyof typeof LOG_CONFIG.loggers): Logger => {
  const existing = loggerInstances.get(name);
  if (existing) return existing;

  const logger = createLogger({
    name: LOG_CONFIG.loggers[name].name,
    level: LOG_CONFIG.level,
    filepath: LOG_CONFIG.path,
  });

  loggerInstances.set(name, logger);
  return logger;
};

// Public logger getters
export const getApiLogger = (): Logger => getOrCreateLogger('api');
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');
