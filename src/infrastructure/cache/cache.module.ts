import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as IOE from 'fp-ts/IOEither';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { createRedisClient } from './client/redis.client';
import { loadRedisConfig } from './config/redis.config';
import { createCache } from './core/manager';
import { createCacheError, logCacheError, logCacheInfo } from './core/utils';
import { createWarmer } from './core/warmer';
import {
  CacheError,
  CacheErrorType,
  CacheItem,
  CacheModuleOperations,
  CacheModuleState,
  CacheOperations,
  CacheWarmerOperations,
  DataProvider,
  RedisClient,
} from './types';

const createInitialState = (): CacheModuleState =>
  ({
    redisClient: O.none,
    cacheOps: O.none,
    warmerOps: O.none,
  }) as CacheModuleState;

export const createCacheModule = (): CacheModuleOperations => {
  const state = createInitialState() as {
    redisClient: O.Option<RedisClient>;
    cacheOps: O.Option<CacheOperations>;
    warmerOps: O.Option<CacheWarmerOperations>;
  };

  const initialize = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.fromEither(loadRedisConfig()),
      TE.mapLeft((error) => {
        const cacheError = createCacheError(CacheErrorType.OPERATION, error.message, error);
        logCacheError(cacheError)();
        return cacheError;
      }),
      TE.chain((config) =>
        pipe(
          createRedisClient(config),
          IOE.mapLeft((error) =>
            createCacheError(CacheErrorType.CONNECTION, 'Failed to create Redis client', error),
          ),
          TE.fromIOEither,
          TE.map((client) => {
            state.redisClient = O.some(client);
            return client;
          }),
        ),
      ),
      TE.chain((client) => client.connect()),
      TE.chain(() =>
        pipe(
          state.redisClient,
          O.fold(
            () =>
              E.left(createCacheError(CacheErrorType.CONNECTION, 'Redis client not initialized')),
            (client) => E.right<CacheError, RedisClient>(client),
          ),
          TE.fromEither,
          TE.map((client) => {
            state.cacheOps = O.some(createCache(client));
            return undefined;
          }),
        ),
      ),
      TE.chainFirst(() => logCacheInfo('Cache module initialized successfully')),
    );

  const initializeWarmer = (
    dataProviders: readonly DataProvider<CacheItem>[],
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      getCache(),
      TE.fromEither,
      TE.chain((cache) => {
        state.warmerOps = O.some(createWarmer(cache, dataProviders));
        return pipe(
          state.warmerOps,
          O.fold(
            () => TE.left(createCacheError(CacheErrorType.OPERATION, 'Warmer not initialized')),
            (warmer) => warmer.initialize(),
          ),
        );
      }),
    );

  const getCache = (): E.Either<CacheError, CacheOperations> =>
    pipe(
      state.cacheOps,
      O.fold(
        () =>
          E.left(createCacheError(CacheErrorType.OPERATION, 'Cache operations not initialized')),
        E.right,
      ),
    );

  const getRedisClient = (): E.Either<CacheError, RedisClient> =>
    pipe(
      state.redisClient,
      O.fold(
        () => E.left(createCacheError(CacheErrorType.CONNECTION, 'Redis client not initialized')),
        E.right,
      ),
    );

  const shutdown = (): TE.TaskEither<CacheError, void> =>
    pipe(
      state.redisClient,
      O.fold(
        () => TE.left(createCacheError(CacheErrorType.CONNECTION, 'Redis client not initialized')),
        (client) =>
          pipe(
            client.disconnect(),
            TE.chainFirst(() => logCacheInfo('Cache module shutting down')),
          ),
      ),
    );

  return {
    initialize,
    initializeWarmer,
    getCache,
    getRedisClient,
    shutdown,
  };
};

let moduleInstance: CacheModuleOperations | undefined;

export const getCacheModule = (): CacheModuleOperations => {
  if (!moduleInstance) {
    moduleInstance = createCacheModule();
  }
  return moduleInstance;
};
