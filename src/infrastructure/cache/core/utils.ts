import * as TE from 'fp-ts/TaskEither';
import { getApiLogger } from '../../logger';
import { CacheError, CacheErrorType } from '../types';

export const createCacheError = (
  type: CacheErrorType,
  message: string,
  cause?: unknown,
): CacheError => ({
  type,
  message,
  cause,
});

export const logCacheError = (error: CacheError): TE.TaskEither<CacheError, void> => {
  const logger = getApiLogger();
  return TE.fromIO(() => logger.error({ message: error.message, context: { error } }));
};

export const logCacheInfo = (message: string): TE.TaskEither<CacheError, void> => {
  const logger = getApiLogger();
  return TE.fromIO(() => logger.info({ message }));
};
