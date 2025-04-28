import { LOG_CONFIG, createLogger } from 'configs/logger/logger.config';
import { Logger } from 'pino';

const loggerInstances = new Map<string, Logger>();

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

export const getApiLogger = (): Logger => getOrCreateLogger('api');
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');
export const getWorkflowLogger = (): Logger => getOrCreateLogger('workflow');
