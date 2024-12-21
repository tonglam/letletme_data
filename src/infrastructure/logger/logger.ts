import { pino } from 'pino';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogContext {
  [key: string]: unknown;
}

export interface LogMessage {
  message: string;
  context?: LogContext;
}

const createLogger = () => {
  const logger = pino({
    level: 'info',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  });

  const createPureLogger = (level: LogLevel) => (logMessage: LogMessage) => () => {
    const { message, context } = logMessage;
    logger[level]({ message, ...(context || {}) });
  };

  const setLogLevel = (level: LogLevel) => () => {
    logger.level = level;
  };

  return {
    error: createPureLogger('error'),
    warn: createPureLogger('warn'),
    info: createPureLogger('info'),
    debug: createPureLogger('debug'),
    setLogLevel,
  };
};

export const logger = createLogger();
