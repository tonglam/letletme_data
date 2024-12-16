import { pino } from 'pino';

interface LogMessage {
  message: string;
}

const logger = pino({ level: 'info' });

const createPureLogger = (level: pino.Level) => (message: LogMessage) => () => {
  logger[level](message);
};

export const infoLogger = createPureLogger('info');
export const warnLogger = createPureLogger('warn');
export const errorLogger = createPureLogger('error');
