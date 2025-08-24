import pino from 'pino';

// Create logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: true,
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

// Logger helpers
export const logInfo = (message: string, data?: object) => {
  logger.info(data, message);
};

export const logError = (message: string, error?: Error | unknown, data?: object) => {
  logger.error({ ...data, error }, message);
};

export const logDebug = (message: string, data?: object) => {
  logger.debug(data, message);
};

export const logWarn = (message: string, data?: object) => {
  logger.warn(data, message);
};
