import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { ChainableCommander } from 'ioredis';
import { createCache } from '../../../../src/infrastructure/cache/core/cache';
import {
  CacheError,
  CacheErrorType,
  RedisClient,
} from '../../../../src/infrastructure/cache/types';

describe('Cache', () => {
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

  const cache = createCache<string>(mockRedisClient, 'test');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Cache Factory', () => {
    test('should throw error for empty prefix', () => {
      expect(() => createCache(mockRedisClient, '')).toThrow('Cache prefix is required');
      expect(() => createCache(mockRedisClient, '  ')).toThrow('Cache prefix is required');
    });
  });

  describe('Set Operation', () => {
    const testKey = 'test-key';
    const testValue = 'test-value';

    test('should validate empty key', async () => {
      const result = await pipe(
        cache.set('', testValue),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid cache key');
    });

    test('should validate whitespace key', async () => {
      const result = await pipe(
        cache.set('  ', testValue),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid cache key');
    });

    test('should validate negative TTL', async () => {
      const result = await pipe(
        cache.set(testKey, testValue, -1),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid TTL value');
    });

    test('should validate NaN TTL', async () => {
      const result = await pipe(
        cache.set(testKey, testValue, NaN),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid TTL value');
    });

    test('should set value successfully', async () => {
      mockRedisClient.set.mockReturnValueOnce(TE.right(void 0));

      const result = await pipe(
        cache.set(testKey, testValue),
        TE.fold(
          () => T.of(false),
          () => T.of(true),
        ),
      )();

      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test:test-key',
        expect.any(String),
        undefined,
      );
    });

    test('should set value with TTL successfully', async () => {
      mockRedisClient.set.mockReturnValueOnce(TE.right(void 0));

      const result = await pipe(
        cache.set(testKey, testValue, 60),
        TE.fold(
          () => T.of(false),
          () => T.of(true),
        ),
      )();

      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test:test-key',
        expect.any(String),
        60,
      );
    });

    test('should handle Redis errors', async () => {
      const redisError = { type: CacheErrorType.OPERATION, message: 'Redis error' } as CacheError;
      mockRedisClient.set.mockReturnValueOnce(TE.left(redisError));

      const result = await pipe(
        cache.set(testKey, testValue),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toEqual(redisError);
    });
  });

  describe('Get Operation', () => {
    const testKey = 'test-key';
    const testValue = 'test-value';

    test('should validate empty key', async () => {
      const result = await pipe(
        cache.get(''),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid cache key');
    });

    test('should validate whitespace key', async () => {
      const result = await pipe(
        cache.get('  '),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.VALIDATION);
      expect(result.message).toBe('Invalid cache key');
    });

    test('should handle non-existent keys', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.none));

      const result = await pipe(
        cache.get(testKey),
        TE.fold(
          () => T.of(null),
          (value) => T.of(value),
        ),
      )();

      expect(result).toBeNull();
      expect(mockRedisClient.get).toHaveBeenCalledWith('test:test-key');
    });

    test('should get value successfully', async () => {
      const timestamp = Date.now();
      const cachedData = JSON.stringify({
        value: testValue,
        timestamp,
      });
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some(cachedData)));

      const result = await pipe(
        cache.get(testKey),
        TE.fold(
          () => T.of(null),
          (value) => T.of(value),
        ),
      )();

      expect(result).toBe(testValue);
      expect(mockRedisClient.get).toHaveBeenCalledWith('test:test-key');
    });

    test('should handle invalid JSON data', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some('invalid json')));

      const result = await pipe(
        cache.get(testKey),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toHaveProperty('type', CacheErrorType.OPERATION);
      expect(result).toHaveProperty('message', 'Failed to parse cache value');
    });

    test('should handle invalid cache data structure', async () => {
      const invalidData = JSON.stringify('not an object');
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some(invalidData)));

      const result = await pipe(
        cache.get(testKey),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toHaveProperty('type', CacheErrorType.OPERATION);
      expect(result).toHaveProperty('message', 'Failed to parse cache value');
    });

    test('should handle Redis errors', async () => {
      const redisError = { type: CacheErrorType.OPERATION, message: 'Redis error' } as CacheError;
      mockRedisClient.get.mockReturnValueOnce(TE.left(redisError));

      const result = await pipe(
        cache.get(testKey),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toEqual(redisError);
    });
  });

  describe('Delete Operation', () => {
    const testKey = 'test-key';

    test('should delete successfully', async () => {
      mockRedisClient.del.mockReturnValueOnce(TE.right(1));

      const result = await pipe(
        cache.del(testKey),
        TE.getOrElse(() => T.of(0)),
      )();

      expect(result).toBe(1);
      expect(mockRedisClient.del).toHaveBeenCalledWith('test:test-key');
    });

    test('should handle non-existent key', async () => {
      mockRedisClient.del.mockReturnValueOnce(TE.right(0));

      const result = await pipe(
        cache.del(testKey),
        TE.getOrElse(() => T.of(-1)),
      )();

      expect(result).toBe(0);
      expect(mockRedisClient.del).toHaveBeenCalledWith('test:test-key');
    });

    test('should handle Redis errors', async () => {
      const redisError = { type: CacheErrorType.OPERATION, message: 'Redis error' } as CacheError;
      mockRedisClient.del.mockReturnValueOnce(TE.left(redisError));

      const result = await pipe(
        cache.del(testKey),
        TE.mapLeft((error: CacheError) => error),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toEqual(redisError);
    });
  });
});
