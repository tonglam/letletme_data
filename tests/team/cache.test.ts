import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createTeamCache } from '../../src/domain/team/cache';
import { TeamDataProvider } from '../../src/domain/team/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { RedisCache } from '../../src/infrastructure/cache/redis-cache';
import { CacheErrorCode } from '../../src/types/error.type';
import { Team, toDomainTeam } from '../../src/types/team.type';
import bootstrapData from '../data/bootstrap.json';

describe('Team Cache Tests', () => {
  let cache: RedisCache<Team>;
  let dataProvider: TeamDataProvider;
  let testTeams: Team[];

  beforeAll(() => {
    testTeams = bootstrapData.teams.map((team) => toDomainTeam(team));

    dataProvider = {
      getOne: jest.fn().mockImplementation(async (id: number) => {
        const team = testTeams.find((t) => t.id === id);
        return team || null;
      }),
      getAll: jest.fn().mockImplementation(async () => testTeams),
    };

    cache = {
      client: redisClient,
      get: jest.fn().mockReturnValue(TE.right(null)),
      set: jest.fn().mockReturnValue(TE.right(undefined)),
      hGet: jest.fn().mockReturnValue(TE.right(null)),
      hSet: jest.fn().mockReturnValue(TE.right(undefined)),
      hGetAll: jest.fn().mockReturnValue(TE.right({})),
    };
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await redisClient.flushdb();
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  describe('Cache Operations', () => {
    it('should warm up cache with all teams', async () => {
      const teamCache = createTeamCache(cache, dataProvider);

      await pipe(
        teamCache.warmUp(),
        TE.fold(
          (error) => T.of(E.left(error)),
          () => T.of(E.right(undefined)),
        ),
      )();

      expect(dataProvider.getAll).toHaveBeenCalled();
      const cachedTeams = await redisClient.hgetall(`${CachePrefix.TEAM}::2023`);
      expect(Object.keys(cachedTeams).length).toBe(testTeams.length);
    });

    it('should cache individual team', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      const testTeam = testTeams[0];

      await pipe(
        teamCache.cacheTeam(testTeam),
        TE.fold(
          (error) => T.of(E.left(error)),
          () => T.of(E.right(undefined)),
        ),
      )();

      const teamFromCache = await redisClient.hget(
        `${CachePrefix.TEAM}::2023`,
        testTeam.id.toString(),
      );
      expect(teamFromCache).toBeDefined();
      expect(JSON.parse(teamFromCache!)).toMatchObject({
        id: testTeam.id,
        name: testTeam.name,
      });
    });

    it('should cache multiple teams', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      const testTeamsSubset = testTeams.slice(0, 3);

      await pipe(
        teamCache.cacheTeams(testTeamsSubset),
        TE.fold(
          (error) => T.of(E.left(error)),
          () => T.of(E.right(undefined)),
        ),
      )();

      const cachedTeams = await redisClient.hgetall(`${CachePrefix.TEAM}::2023`);
      expect(Object.keys(cachedTeams).length).toBe(testTeamsSubset.length);
    });

    it('should get team from cache', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      const testTeam = testTeams[0];

      await teamCache.cacheTeam(testTeam)();

      const result = await pipe(
        teamCache.getTeam(testTeam.id.toString()),
        TE.fold(
          (error) => T.of(E.left(error)),
          (team) => T.of(E.right(team)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const team = result.right;
        expect(team).toBeDefined();
        expect(team?.id).toBe(testTeam.id);
        expect(team?.name).toBe(testTeam.name);
      }
    });

    it('should get all teams from cache', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      await teamCache.cacheTeams(testTeams)();

      const result = await pipe(
        teamCache.getAllTeams(),
        TE.fold(
          (error) => T.of(E.left(error)),
          (teams) => T.of(E.right(teams)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const teams = result.right;
        expect(teams).toHaveLength(testTeams.length);
        expect(teams[0]).toMatchObject({
          id: testTeams[0].id,
          name: testTeams[0].name,
        });
      }
    });

    it('should handle missing team in cache', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      const nonExistentId = '999';

      const result = await pipe(
        teamCache.getTeam(nonExistentId),
        TE.fold(
          (error) => T.of(E.left(error)),
          (team) => T.of(E.right(team)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
        expect(dataProvider.getOne).toHaveBeenCalledWith(Number(nonExistentId));
      }
    });

    it('should handle empty cache for getAllTeams', async () => {
      const teamCache = createTeamCache(cache, dataProvider);

      const result = await pipe(
        teamCache.getAllTeams(),
        TE.fold(
          (error) => T.of(E.left(error)),
          (teams) => T.of(E.right(teams)),
        ),
      )();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const teams = result.right;
        expect(teams).toHaveLength(testTeams.length);
        expect(dataProvider.getAll).toHaveBeenCalled();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle cache operation errors', async () => {
      const mockError = new Error('Redis error');
      jest.spyOn(redisClient, 'hset').mockRejectedValueOnce(mockError);

      const teamCache = createTeamCache(cache, dataProvider);
      const testTeam = testTeams[0];

      const result = await teamCache.cacheTeam(testTeam)();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to cache team');
      }
    });

    it('should handle data provider errors', async () => {
      const mockError = new Error('Data provider error');
      jest.spyOn(dataProvider, 'getOne').mockRejectedValueOnce(mockError);

      const teamCache = createTeamCache(cache, dataProvider);
      const result = await teamCache.getTeam('1')();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.OPERATION_ERROR);
        expect(result.left.message).toContain('Failed to get team from provider');
      }
    });

    it('should handle JSON parsing errors', async () => {
      const teamCache = createTeamCache(cache, dataProvider);
      await redisClient.hset(`${CachePrefix.TEAM}::2023`, '1', 'invalid json');

      const result = await teamCache.getTeam('1')();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(CacheErrorCode.DESERIALIZATION_ERROR);
        expect(result.left.message).toContain('Failed to parse team JSON');
      }
    });
  });
});
