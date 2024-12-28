/**
 * Logger Infrastructure Module
 *
 * Provides a centralized logging system with multiple logger instances.
 * Implements a factory pattern for logger management.
 *
 * Features:
 * - Cached logger instances
 * - Multiple logger types
 * - Configuration-driven setup
 * - Singleton pattern per logger type
 * - Type-safe logger access
 *
 * The module ensures consistent logging across the application
 * with proper configuration and instance management.
 */

import { Logger } from 'pino';
import { LOG_CONFIG, createLogger } from '../../config/logger/logger.config';

/**
 * Cache for logger instances.
 * Ensures single instance per logger type.
 */
const loggerInstances = new Map<string, Logger>();

/**
 * Core logger factory function.
 * Creates or retrieves cached logger instances.
 *
 * @param name - The name of the logger from configuration
 * @returns Configured logger instance
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
 * Gets the API logger instance.
 * Used for logging API-related operations.
 *
 * @returns Configured API logger
 */
export const getApiLogger = (): Logger => getOrCreateLogger('api');

/**
 * Gets the FPL API logger instance.
 * Used for logging FPL API interactions.
 *
 * @returns Configured FPL API logger
 */
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');

/**
 * Gets the Queue logger instance.
 * Used for logging queue operations.
 *
 * @returns Configured queue logger
 */
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');

/**
 * Gets the Workflow logger instance.
 * Used for logging workflow executions.
 *
 * @returns Configured workflow logger
 */
export const getWorkflowLogger = (): Logger => getOrCreateLogger('workflow');
