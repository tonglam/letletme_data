import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { createPhaseCache } from '../../src/domain/phase/cache';
import { toDomainPhase } from '../../src/domain/phase/types';
import { getTestPhase, getTestPhases } from '../data/bootstrap.test';
import { redis } from '../setup';

describe('Phase Cache', () => {
  const mockDataProvider = {
    getOne: jest.fn(),
    getAll: jest.fn(),
  };

  const phaseCache = createPhaseCache(redis, mockDataProvider, {
    keyPrefix: 'phase',
    season: 2023,
  });

  beforeEach(async () => {
    await redis.flushDb();
    jest.clearAllMocks();
  });

  describe('cachePhase', () => {
    it('should cache single phase', async () => {
      const phaseResponse = getTestPhase(1)!;
      const phase = toDomainPhase(phaseResponse);
      const result = await phaseCache.cachePhase(phase)();

      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getPhase(String(phase.id))();
      expect(E.isRight(cached)).toBe(true);
      pipe(
        cached,
        E.map((cachedPhase) => {
          expect(cachedPhase).toEqual(phase);
        }),
      );
    });

    it('should handle cache errors', async () => {
      await redis.quit();

      const phaseResponse = getTestPhase(1)!;
      const phase = toDomainPhase(phaseResponse);
      const result = await phaseCache.cachePhase(phase)();

      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to set cache');
        }),
      );

      await redis.connect();
    });
  });

  describe('cachePhases', () => {
    it('should cache multiple phases', async () => {
      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      const result = await phaseCache.cachePhases(phases)();

      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getAllPhases()();
      expect(E.isRight(cached)).toBe(true);
      pipe(
        cached,
        E.map((cachedPhases) => {
          expect(cachedPhases).toHaveLength(3);
          expect(cachedPhases).toEqual(expect.arrayContaining(phases));
        }),
      );
    });

    it('should handle empty array', async () => {
      const result = await phaseCache.cachePhases([])();

      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getAllPhases()();
      expect(E.isRight(cached)).toBe(true);
      pipe(
        cached,
        E.map((cachedPhases) => {
          expect(cachedPhases).toHaveLength(0);
        }),
      );
    });

    it('should handle cache errors', async () => {
      await redis.quit();

      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      const result = await phaseCache.cachePhases(phases)();

      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to set cache');
        }),
      );

      await redis.connect();
    });
  });

  describe('getPhase', () => {
    it('should return cached phase', async () => {
      const phaseResponse = getTestPhase(1)!;
      const phase = toDomainPhase(phaseResponse);
      await phaseCache.cachePhase(phase)();

      const result = await phaseCache.getPhase(String(phase.id))();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((cachedPhase) => {
          expect(cachedPhase).toEqual(phase);
        }),
      );
    });

    it('should return null for non-existent phase', async () => {
      mockDataProvider.getOne.mockResolvedValue(null);

      const result = await phaseCache.getPhase('999')();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((phase) => {
          expect(phase).toBeNull();
        }),
      );
    });

    it('should fetch from data provider on cache miss', async () => {
      const phaseResponse = getTestPhase(1)!;
      const phase = toDomainPhase(phaseResponse);
      mockDataProvider.getOne.mockResolvedValue(phase);

      const result = await phaseCache.getPhase(String(phase.id))();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((fetchedPhase) => {
          expect(fetchedPhase).toEqual(phase);
          expect(mockDataProvider.getOne).toHaveBeenCalledWith(phase.id);
        }),
      );
    });

    it('should handle cache errors', async () => {
      await redis.quit();

      const result = await phaseCache.getPhase('1')();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to get cache');
        }),
      );

      await redis.connect();
    });
  });

  describe('getAllPhases', () => {
    it('should return all cached phases', async () => {
      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      await phaseCache.cachePhases(phases)();

      const result = await phaseCache.getAllPhases()();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((cachedPhases) => {
          expect(cachedPhases).toHaveLength(3);
          expect(cachedPhases).toEqual(expect.arrayContaining(phases));
        }),
      );
    });

    it('should return empty array when cache is empty', async () => {
      const result = await phaseCache.getAllPhases()();
      expect(E.isRight(result)).toBe(true);
      pipe(
        result,
        E.map((phases) => {
          expect(phases).toHaveLength(0);
        }),
      );
    });

    it('should handle cache errors', async () => {
      await redis.quit();

      const result = await phaseCache.getAllPhases()();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to get all cache');
        }),
      );

      await redis.connect();
    });
  });

  describe('warmUp', () => {
    it('should warm up cache with data from provider', async () => {
      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      mockDataProvider.getAll.mockResolvedValue(phases);

      const result = await phaseCache.warmUp()();
      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getAllPhases()();
      expect(E.isRight(cached)).toBe(true);
      pipe(
        cached,
        E.map((cachedPhases) => {
          expect(cachedPhases).toHaveLength(3);
          expect(cachedPhases).toEqual(expect.arrayContaining(phases));
          expect(mockDataProvider.getAll).toHaveBeenCalled();
        }),
      );
    });

    it('should handle empty data from provider', async () => {
      mockDataProvider.getAll.mockResolvedValue([]);

      const result = await phaseCache.warmUp()();
      expect(E.isRight(result)).toBe(true);

      const cached = await phaseCache.getAllPhases()();
      expect(E.isRight(cached)).toBe(true);
      pipe(
        cached,
        E.map((phases) => {
          expect(phases).toHaveLength(0);
        }),
      );
    });

    it('should handle provider errors', async () => {
      mockDataProvider.getAll.mockRejectedValue(new Error('Provider error'));

      const result = await phaseCache.warmUp()();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to warm up phase cache');
        }),
      );
    });

    it('should handle cache errors during warm up', async () => {
      const phaseResponses = getTestPhases().slice(0, 3);
      const phases = phaseResponses.map(toDomainPhase);
      mockDataProvider.getAll.mockResolvedValue(phases);
      await redis.quit();

      const result = await phaseCache.warmUp()();
      expect(E.isLeft(result)).toBe(true);
      pipe(
        result,
        E.mapLeft((error) => {
          expect(error.code).toBe('CACHE_ERROR');
          expect(error.message).toContain('Failed to set cache');
        }),
      );

      await redis.connect();
    });
  });
});
