import { beforeEach, describe, expect, test } from '@jest/globals';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPhaseCache, createPhaseOperations } from '../../../src/domains/phases/cache';
import { CacheError, CacheErrorType, RedisClient } from '../../../src/infrastructure/cache/types';
import { PrismaPhase } from '../../../src/types/phases.type';

describe('Phase Cache', () => {
  const mockRedisClient = {
    connect: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    disconnect: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    set: jest.fn((): TE.TaskEither<CacheError, void> => TE.right(void 0)),
    get: jest.fn((): TE.TaskEither<CacheError, O.Option<string>> => TE.right(O.none)),
    del: jest.fn((): TE.TaskEither<CacheError, number> => TE.right(1)),
    keys: jest.fn((): TE.TaskEither<CacheError, string[]> => TE.right([])),
    multi: jest.fn(),
    isReady: jest.fn(() => true),
    exec: jest.fn(),
    ping: jest.fn(),
  } satisfies RedisClient;

  const mockPhase: PrismaPhase = {
    id: 1,
    name: 'Test Phase',
    startEvent: 1,
    stopEvent: 38,
    highestScore: 100,
    createdAt: new Date(),
  };

  const mockDataProvider = {
    getAll: jest.fn(async () => [mockPhase]),
    getOne: jest.fn(async (id: string) => (id === String(mockPhase.id) ? mockPhase : null)),
  };

  const cache = createPhaseCache(mockRedisClient);
  const phaseCache = createPhaseOperations(cache, mockDataProvider);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Cache Phase', () => {
    test('should cache phase successfully', async () => {
      const result = await pipe(
        phaseCache.cachePhase(mockPhase),
        TE.fold(
          () => T.of(false),
          () => T.of(true),
        ),
      )();

      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'phase:1',
        expect.any(String),
        expect.any(Number),
      );
    });

    test('should handle cache error', async () => {
      mockRedisClient.set.mockReturnValueOnce(
        TE.left({ type: CacheErrorType.OPERATION, message: 'Redis error' }),
      );

      const result = await pipe(
        phaseCache.cachePhase(mockPhase),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.OPERATION);
      expect(result.message).toBe('Failed to cache phase');
      expect(result.cause).toBeDefined();
    });
  });

  describe('Get Phase', () => {
    test('should get phase from cache', async () => {
      const timestamp = Date.now();
      const cachedData = JSON.stringify({
        value: { ...mockPhase, createdAt: mockPhase.createdAt.toISOString() },
        timestamp,
      });
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some(cachedData)));

      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          () => T.of(null),
          (value) =>
            value ? T.of({ ...value, createdAt: new Date(value.createdAt) }) : T.of(null),
        ),
      )();

      expect(result).toEqual(mockPhase);
      expect(mockRedisClient.get).toHaveBeenCalledWith('phase:1');
      expect(mockDataProvider.getOne).not.toHaveBeenCalled();
    });

    test('should fetch from provider when not in cache', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.none));

      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          () => T.of(null),
          (value) => T.of(value),
        ),
      )();

      expect(result).toEqual(mockPhase);
      expect(mockRedisClient.get).toHaveBeenCalledWith('phase:1');
      expect(mockDataProvider.getOne).toHaveBeenCalledWith('1');
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'phase:1',
        expect.any(String),
        expect.any(Number),
      );
    });

    test('should handle non-existent phase', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.none));
      mockDataProvider.getOne.mockResolvedValueOnce(null);

      const result = await pipe(
        phaseCache.getPhase('999'),
        TE.fold(
          () => T.of(null),
          (value) => T.of(value),
        ),
      )();

      expect(result).toBeNull();
      expect(mockRedisClient.get).toHaveBeenCalledWith('phase:999');
      expect(mockDataProvider.getOne).toHaveBeenCalledWith('999');
    });

    test('should handle invalid cache data', async () => {
      mockRedisClient.get.mockReturnValueOnce(TE.right(O.some('invalid json')));

      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.CONNECTION);
      expect(result.message).toBe('Failed to get phase from cache');
      expect(result.cause).toBeDefined();
    });
  });

  describe('Get All Phases', () => {
    test('should get all phases from provider and cache them', async () => {
      const phases = [mockPhase];
      mockDataProvider.getAll.mockResolvedValueOnce(phases);

      const result = await pipe(
        phaseCache.getAllPhases(),
        TE.fold(
          () => T.of([]),
          (value) => T.of(value),
        ),
      )();

      expect(result).toEqual(phases);
      expect(mockDataProvider.getAll).toHaveBeenCalled();
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'phase:1',
        expect.any(String),
        expect.any(Number),
      );
    });

    test('should handle provider error', async () => {
      const providerError = new Error('Provider error');
      mockDataProvider.getAll.mockRejectedValueOnce(providerError);

      const result = await pipe(
        phaseCache.getAllPhases(),
        TE.fold(
          (error) => T.of(error),
          () =>
            T.of({
              type: CacheErrorType.OPERATION,
              message: 'Failed to fetch phases data',
              cause: providerError,
            } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.OPERATION);
      expect(result.message).toBe('Failed to fetch phases data');
      expect(result.cause).toBeDefined();
    });
  });

  describe('Cache Batch', () => {
    test('should cache multiple phases', async () => {
      mockRedisClient.set.mockReturnValueOnce(TE.right(undefined));

      const result = await pipe(
        phaseCache.cacheBatch([mockPhase]),
        TE.fold(
          () => T.of(false),
          () => T.of(true),
        ),
      )();

      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'phase:1',
        expect.any(String),
        expect.any(Number),
      );
    });

    test('should handle batch cache error', async () => {
      const redisError = { type: CacheErrorType.OPERATION, message: 'Redis error' };
      mockRedisClient.set.mockImplementationOnce(() => () => Promise.reject(redisError));

      const result = await pipe(
        phaseCache.cacheBatch([mockPhase]),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result.type).toBe(CacheErrorType.OPERATION);
      expect(result.message).toBe('Failed to cache phases batch');
      expect(result.cause).toBeDefined();
    });
  });
});
