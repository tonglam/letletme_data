import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import {
  BATCH_SIZE,
  CacheDependencyConfig,
  CacheDependencyInfo,
  CacheError,
  CacheErrorType,
  CacheOperations,
  CacheWrapper,
  DomainType,
  InvalidationPattern,
  KeyPatternConfig,
  RedisClient,
  TTLConfig,
} from '../types';

// Helper functions
const createError = (type: CacheErrorType, message: string, cause?: unknown): CacheError => ({
  type,
  message,
  cause,
});

const serializeValue = <T>(value: T): E.Either<CacheError, string> =>
  pipe(
    E.tryCatch(
      () => JSON.stringify(value),
      (error) => createError(CacheErrorType.OPERATION, 'Failed to serialize value', error),
    ),
  );

const deserializeValue = <T>(value: string): E.Either<CacheError, T> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(value) as T,
      (error) => createError(CacheErrorType.OPERATION, 'Failed to parse cached value', error),
    ),
  );

const createTimeoutPromise = (ms: number): Promise<never> =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms),
  );

// Add batching for large key operations
const batchOperation = <T>(
  items: readonly T[],
  operation: (batch: readonly T[]) => TE.TaskEither<CacheError, readonly string[]>,
): TE.TaskEither<CacheError, readonly string[]> => {
  const batches = Array.from({ length: Math.ceil(items.length / BATCH_SIZE) }, (_, i) =>
    items.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
  );

  return pipe(
    batches,
    A.traverse(TE.ApplicativeSeq)(operation),
    TE.map((results) => results.flat()),
  );
};

// Core cache operations factory
export const createCacheOperations = (redis: RedisClient): CacheOperations => {
  // Add batch support for keys operation
  const keys = (pattern: string): TE.TaskEither<CacheError, readonly string[]> =>
    pipe(
      redis.keys(pattern),
      TE.chain((keys) =>
        keys.length > BATCH_SIZE
          ? pipe(
              batchOperation(keys, () => redis.keys(pattern)),
              TE.map(() => keys),
            )
          : TE.right(keys),
      ),
    );

  const set = <T>(
    domain: DomainType,
    id: string,
    value: T,
    ttl: number = TTLConfig.METADATA,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      { value, timestamp: Date.now() } as CacheWrapper<T>,
      serializeValue,
      TE.fromEither,
      TE.chain((serializedValue) =>
        redis.set(KeyPatternConfig.primary(domain, id), serializedValue, ttl),
      ),
    );

  const get = <T>(domain: DomainType, id: string): TE.TaskEither<CacheError, O.Option<T>> =>
    pipe(
      redis.get(KeyPatternConfig.primary(domain, id)),
      TE.chain((value) =>
        pipe(
          value,
          O.traverse(E.Applicative)((str) => deserializeValue<CacheWrapper<T>>(str)),
          E.map(O.map((wrapper) => wrapper.value)),
          TE.fromEither,
        ),
      ),
    );

  const getKeysToInvalidate = (
    domain: DomainType,
    id: string,
    cascade: boolean,
  ): TE.TaskEither<CacheError, readonly string[]> => {
    const primaryKey = KeyPatternConfig.primary(domain, id);

    if (!cascade) {
      return TE.right([primaryKey]);
    }

    const getDependentDomains = flow(
      O.fromNullable as (a: unknown) => O.Option<CacheDependencyInfo>,
      O.map((config) => Array.from(config.invalidates ?? [])),
      O.getOrElse<DomainType[]>(() => []),
    );

    return pipe(
      CacheDependencyConfig[domain as keyof typeof CacheDependencyConfig],
      getDependentDomains,
      A.map((dependentDomain: DomainType) =>
        redis.keys(KeyPatternConfig.related(dependentDomain, domain, id)),
      ),
      A.sequence(TE.ApplicativePar),
      TE.map((arrays) => arrays.reduce<readonly string[]>((acc, curr) => [...acc, ...curr], [])),
      TE.map((dependentKeys) => [primaryKey, ...dependentKeys]),
    );
  };

  const invalidate = (
    domain: DomainType,
    id: string,
    cascade = true,
  ): TE.TaskEither<CacheError, number> =>
    pipe(
      getKeysToInvalidate(domain, id, cascade),
      TE.chain((keys) => redis.del(...keys)),
    );

  const atomicUpdate = <T>(
    pattern: InvalidationPattern,
    updateFn: () => Promise<T>,
  ): TE.TaskEither<CacheError, T> =>
    pipe(
      redis.multi(),
      TE.chain((transaction) =>
        pipe(
          TE.tryCatch(
            async () => {
              const result = await Promise.race([
                updateFn(),
                createTimeoutPromise(5000), // Add timeout for update function
              ]);

              // Add transaction timeout
              const txTimeout = setTimeout(() => transaction.discard(), 5000);

              try {
                await Promise.all([
                  ...pattern.related.map((key) => transaction.del(key)),
                  transaction.del(pattern.primary),
                ]);

                const execResult = await transaction.exec();
                clearTimeout(txTimeout);

                if (!execResult) {
                  throw new Error('Transaction failed');
                }

                return result;
              } catch (error) {
                clearTimeout(txTimeout);
                await transaction.discard();
                throw error;
              }
            },
            (error) => createError(CacheErrorType.OPERATION, 'Transaction failed', error),
          ),
        ),
      ),
    );

  const checkHealth = (): TE.TaskEither<CacheError, boolean> =>
    pipe(
      redis.set('health-check', 'ok', TTLConfig.TEMPORARY),
      TE.map(() => true),
      TE.orElse((error) =>
        TE.left(createError(CacheErrorType.CONNECTION, 'Cache health check failed', error)),
      ),
    );

  return {
    keys,
    set,
    get,
    invalidate,
    atomicUpdate,
    checkHealth,
  };
};

// Export factory function
export const createCache = (redis: RedisClient): CacheOperations => createCacheOperations(redis);
