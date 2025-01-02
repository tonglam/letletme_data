// Logger Infrastructure Module
//
// A centralized logging system that manages multiple logger instances using pino.
// Implements a singleton pattern per logger type to ensure consistent logging across the application.

import { Logger } from 'pino';
import { LOG_CONFIG, createLogger } from '../../config/logger/logger.config';

// Internal cache to store and manage logger instances
const loggerInstances = new Map<string, Logger>();

// Creates or retrieves an existing logger instance
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

// Retrieves the API logger instance for general API operations logging
export const getApiLogger = (): Logger => getOrCreateLogger('api');

// Retrieves the FPL API logger instance for FPL-specific operations logging
export const getFplApiLogger = (): Logger => getOrCreateLogger('fpl');

// Retrieves the Queue logger instance for queue processing operations logging
export const getQueueLogger = (): Logger => getOrCreateLogger('queue');

// Retrieves the Workflow logger instance for workflow execution logging
export const getWorkflowLogger = (): Logger => getOrCreateLogger('workflow');
