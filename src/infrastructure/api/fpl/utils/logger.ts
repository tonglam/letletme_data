import { createApiLogger, logApiCall } from '../../common/logs';

const logger = createApiLogger({
  name: 'fpl-api',
  level: 'info',
  filepath: './logs/fpl-api.log',
});

export const logFplCall = logApiCall(logger);
