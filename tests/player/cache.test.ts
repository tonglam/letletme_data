import * as E from 'fp-ts/Either';
import { Redis } from 'ioredis';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createPlayerCache } from '../../src/domain/player/cache';
import { RedisCache } from '../../src/infrastructure/cache/redis-cache';
import { ElementType } from '../../src/types/base.type';
import { CacheErrorCode } from '../../src/types/error.type';
import { Player, PlayerId } from '../../src/types/player.type';
import { PlayerDataProvider } from '../../src/types/player/operations.type';

describe('Player Cache Tests', () => {
  let cache: DeepMockProxy<RedisCache<Player>>;
  let dataProvider: DeepMockProxy<PlayerDataProvider>;
  let redisClient: DeepMockProxy<Redis>;

  const testPlayer: Player = {
    id: 1 as PlayerId,
    elementCode: 12345,
    price: 100,
    startPrice: 100,
    elementType: ElementType.GKP,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'T.Player',
    teamId: 1,
  };

  const config = {
    keyPrefix: CachePrefix.PLAYER,
    season: '2023',
  };

  beforeEach(() => {
    redisClient = mockDeep<Redis>();
    cache = mockDeep<RedisCache<Player>>();
    dataProvider = mockDeep<PlayerDataProvider>();
    cache.client = redisClient;
  });

  describe('warmUp', () => {
    it('should warm up cache with players from data provider', async () => {
      const players = [testPlayer];
      dataProvider.getAll.mockResolvedValue(players);
      redisClient.multi.mockReturnThis();
      redisClient.exec.mockResolvedValue([]);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.warmUp()();

      expect(E.isRight(result)).toBe(true);
      expect(redisClient.del).toHaveBeenCalledWith(`${config.keyPrefix}::${config.season}`);
      expect(redisClient.hset).toHaveBeenCalledWith(
        `${config.keyPrefix}::${config.season}`,
        testPlayer.id.toString(),
        JSON.stringify(testPlayer),
      );
    });

    it('should handle empty player list', async () => {
      dataProvider.getAll.mockResolvedValue([]);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.warmUp()();

      expect(E.isRight(result)).toBe(true);
      expect(redisClient.del).not.toHaveBeenCalled();
      expect(redisClient.hset).not.toHaveBeenCalled();
    });

    it('should handle provider errors', async () => {
      dataProvider.getAll.mockRejectedValue(new Error('Provider error'));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.warmUp()();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to warm up cache');
      }
    });
  });

  describe('getPlayer', () => {
    it('should return cached player', async () => {
      redisClient.hget.mockResolvedValue(JSON.stringify(testPlayer));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getPlayer(testPlayer.id.toString())();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayer);
      }
    });

    it('should fetch from provider if not in cache', async () => {
      redisClient.hget.mockResolvedValue(null);
      dataProvider.getOne.mockResolvedValue(testPlayer);
      redisClient.hset.mockResolvedValue(1);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getPlayer(testPlayer.id.toString())();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayer);
      }
      expect(redisClient.hset).toHaveBeenCalledWith(
        `${config.keyPrefix}::${config.season}`,
        testPlayer.id.toString(),
        JSON.stringify(testPlayer),
      );
    });

    it('should handle cache errors', async () => {
      redisClient.hget.mockRejectedValue(new Error('Cache error'));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getPlayer(testPlayer.id.toString())();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to get player from cache');
      }
    });
  });

  describe('getAllPlayers', () => {
    it('should return all cached players', async () => {
      const players = { [testPlayer.id]: JSON.stringify(testPlayer) };
      redisClient.hgetall.mockResolvedValue(players);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getAllPlayers()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toEqual(testPlayer);
      }
    });

    it('should fetch from provider if cache is empty', async () => {
      redisClient.hgetall.mockResolvedValue({});
      dataProvider.getAll.mockResolvedValue([testPlayer]);
      redisClient.multi.mockReturnThis();
      redisClient.exec.mockResolvedValue([]);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getAllPlayers()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toHaveLength(1);
        expect(result.right[0]).toEqual(testPlayer);
      }
      expect(redisClient.del).toHaveBeenCalledWith(`${config.keyPrefix}::${config.season}`);
      expect(redisClient.hset).toHaveBeenCalledWith(
        `${config.keyPrefix}::${config.season}`,
        testPlayer.id.toString(),
        JSON.stringify(testPlayer),
      );
    });

    it('should handle cache errors', async () => {
      redisClient.hgetall.mockRejectedValue(new Error('Cache error'));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.getAllPlayers()();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to get players from cache');
      }
    });
  });

  describe('cachePlayer', () => {
    it('should cache a single player', async () => {
      redisClient.hset.mockResolvedValue(1);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.cachePlayer(testPlayer)();

      expect(E.isRight(result)).toBe(true);
      expect(redisClient.hset).toHaveBeenCalledWith(
        `${config.keyPrefix}::${config.season}`,
        testPlayer.id.toString(),
        JSON.stringify(testPlayer),
      );
    });

    it('should handle cache errors', async () => {
      redisClient.hset.mockRejectedValue(new Error('Cache error'));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.cachePlayer(testPlayer)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to cache player');
      }
    });
  });

  describe('cachePlayers', () => {
    it('should cache multiple players', async () => {
      const players = [testPlayer];
      redisClient.multi.mockReturnThis();
      redisClient.exec.mockResolvedValue([]);

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.cachePlayers(players)();

      expect(E.isRight(result)).toBe(true);
      expect(redisClient.del).toHaveBeenCalledWith(`${config.keyPrefix}::${config.season}`);
      expect(redisClient.hset).toHaveBeenCalledWith(
        `${config.keyPrefix}::${config.season}`,
        testPlayer.id.toString(),
        JSON.stringify(testPlayer),
      );
    });

    it('should handle empty player list', async () => {
      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.cachePlayers([])();

      expect(E.isRight(result)).toBe(true);
      expect(redisClient.del).not.toHaveBeenCalled();
      expect(redisClient.hset).not.toHaveBeenCalled();
    });

    it('should handle cache errors', async () => {
      redisClient.del.mockRejectedValue(new Error('Cache error'));

      const playerCache = createPlayerCache(cache, dataProvider, config);
      const result = await playerCache.cachePlayers([testPlayer])();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to cache players');
      }
    });
  });
});
