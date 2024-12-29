/**
 * Logger Infrastructure Module
 *
 * A centralized logging system that manages multiple logger instances using pino.
 * Implements a singleton pattern per logger type to ensure consistent logging across the application.
 *
 * @module Logger
 */

import { Logger } from 'pino';
import { LOG_CONFIG, createLogger } from '../../config/logger/logger.config';

/**
 * Internal cache to store and manage logger instances
 * @private
 */
const loggerInstances = new Map<string, Logger>();

/**
 * Creates or retrieves an existing logger instance
 *
 * @private
 * @param {keyof typeof LOG_CONFIG.loggers} name - The identifier for the logger configuration
 * @returns {Logger} The logger instance
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
 * Retrieves the API logger instance for general API operations logging
 *
 * @returns {Logger} The API logger instance
 */
export const getApiLogger = (): Logger => getOrCreateLogger('api');

/**
 * Retrieves the FPL API logger instance for FPL-specific operations logging
 *
 * @returns {Logger} The FPL API logger instance
 */
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');

/**
 * Retrieves the Queue logger instance for queue processing operations logging
 *
 * @returns {Logger} The Queue logger instance
 */
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');

/**
 * Retrieves the Workflow logger instance for workflow execution logging
 *
 * @returns {Logger} The Workflow logger instance
 */
export const getWorkflowLogger = (): Logger => getOrCreateLogger('workflow');
