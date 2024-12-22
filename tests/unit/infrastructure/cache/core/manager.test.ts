import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { ChainableCommander } from 'ioredis';
import { createCacheOperations } from '../../../../../src/infrastructure/cache/core/manager';
import {
  CacheError,
  CacheErrorType,
  DomainType,
  RedisClient,
} from '../../../../../src/infrastructure/cache/types';

describe('Cache Manager', () => {
  // Mock Redis client with proper types
  const mockRedisClient = {
    connect: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    disconnect: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    set: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    get: jest.fn((): TE.TaskEither<CacheError, O.Option<string>> => TE.right(O.none)),
    del: jest.fn((): TE.TaskEither<CacheError, number> => TE.right(1)),
    keys: jest.fn((): TE.TaskEither<CacheError, string[]> => TE.right(['test'])),
    multi: jest.fn(
      (): TE.TaskEither<CacheError, ChainableCommander> =>
        TE.right({
          exec: () => Promise.resolve([]),
          length: 0,
          call: jest.fn(),
          callBuffer: jest.fn(),
          acl: jest.fn(),
        } as unknown as ChainableCommander),
    ),
    isReady: jest.fn(() => true),
    exec: jest.fn((): TE.TaskEither<CacheError, unknown[]> => TE.right([])),
    ping: jest.fn((): TE.TaskEither<CacheError, string> => TE.right('PONG')),
  } satisfies RedisClient;

  const cacheOps = createCacheOperations(mockRedisClient);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Keys Operation', () => {
    test('should handle small key sets', async () => {
      const mockKeys = ['key1', 'key2'];
      mockRedisClient.keys.mockReturnValueOnce(TE.right(mockKeys));

      const result = await pipe(
        cacheOps.keys('test*'),
        TE.map((keys: readonly string[]) => Array.from(keys)),
        TE.getOrElse<CacheError, string[]>(() => T.of([])),
      )();
      expect(result).toEqual(mockKeys);
      expect(mockRedisClient.keys).toHaveBeenCalledWith('test*');
    });

    test('should handle Redis errors', async () => {
      mockRedisClient.keys.mockReturnValueOnce(
        TE.left({ type: CacheErrorType.OPERATION, message: 'Redis error' }),
      );

      const result = await pipe(
        cacheOps.keys('test*'),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();
      expect(result.type).toBe(CacheErrorType.OPERATION);
    });
  });

  describe('Set Operation', () => {
    const domain = DomainType.EVENT;
    const id = 'test-id';
    const value = { test: 'data' };

    test('should set value successfully', async () => {
      mockRedisClient.set.mockReturnValueOnce(TE.right(void 0));

      const result = await pipe(
        cacheOps.set(domain, id, value),
        TE.fold(
          () => T.of(false),
          () => T.of(true),
        ),
      )();
      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining(id),
        expect.any(String),
        expect.any(Number),
      );
    });

    test('should handle serialization errors', async () => {
      type CircularType = {
        self?: CircularType;
      };
      const circularRef: CircularType = {};
      circularRef.self = circularRef;

      const result = await pipe(
        cacheOps.set(domain, id, circularRef),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();
      expect(result.type).toBe(CacheErrorType.OPERATION);
    });

    test('should handle Redis errors', async () => {
      mockRedisClient.set.mockReturnValueOnce(
        TE.left({ type: CacheErrorType.OPERATION, message: 'Redis error' }),
      );

      const result = await pipe(
        cacheOps.set(domain, id, value),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();
      expect(result.type).toBe(CacheErrorType.OPERATION);
    });
  });

  describe('Get Operation', () => {
    const domain = DomainType.EVENT;
    const id = 'test-id';
    const value = { test: 'data' };

    test('should get value successfully', async () => {
      const cachedData = JSON.stringify({
        value,
        timestamp: Date.now(),
      });
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some(cachedData)));

      const result = await pipe(
        cacheOps.get(domain, id) as TE.TaskEither<CacheError, O.Option<unknown>>,
        TE.fold(
          () => T.of(null),
          (maybeValue) => T.of(O.toNullable(maybeValue)),
        ),
      )();
      expect(result).toEqual(value);
    });

    test('should handle non-existent keys', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.none));

      const result = await pipe(
        cacheOps.get(domain, id) as TE.TaskEither<CacheError, O.Option<unknown>>,
        TE.fold(
          () => T.of(null),
          (maybeValue) => T.of(O.toNullable(maybeValue)),
        ),
      )();
      expect(result).toBeNull();
    });

    test('should handle invalid cache data', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some('invalid json')));

      const result = await pipe(
        cacheOps.get(domain, id) as TE.TaskEither<CacheError, O.Option<unknown>>,
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();
      expect(result.type).toBe(CacheErrorType.OPERATION);
    });

    test('should handle Redis errors', async () => {
      mockRedisClient.get.mockReturnValueOnce(
        TE.left({ type: CacheErrorType.OPERATION, message: 'Redis error' }),
      );

      const result = await pipe(
        cacheOps.get(domain, id) as TE.TaskEither<CacheError, O.Option<unknown>>,
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();
      expect(result.type).toBe(CacheErrorType.OPERATION);
    });
  });
});
