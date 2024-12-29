/**
 * Logger Infrastructure Module
 *
 * Provides a centralized logging system with multiple logger instances.
 */

import { Logger } from 'pino';
import { LOG_CONFIG, createLogger } from '../../config/logger/logger.config';

/**
 * Cache for logger instances
 */
const loggerInstances = new Map<string, Logger>();

/**
 * Core logger factory function
 */
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

/**
 * Gets the API logger instance
 */
export const getApiLogger = (): Logger => getOrCreateLogger('api');

/**
 * Gets the FPL API logger instance
 */
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');

/**
 * Gets the Queue logger instance
 */
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');

/**
 * Gets the Workflow logger instance
 */
export const getWorkflowLogger = (): Logger => getOrCreateLogger('workflow');
