import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createTeamCache } from '../../src/domain/team/cache';
import { createTeamRepository } from '../../src/domain/team/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createTeamService } from '../../src/service/team';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError } from '../../src/types/error.type';
import type { Team, TeamId } from '../../src/types/team.type';
import { toDomainTeam } from '../../src/types/team.type';

describe('Team Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.TEAM;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;

  // Service dependencies with optimized retry config
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 3,
      baseDelay: 500,
      maxDelay: 2000,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const teamRepository = createTeamRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<Team>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const teamCache = createTeamCache(redisCache, {
    getOne: async (id: number) => {
      const result = await teamRepository.findById(id as TeamId)();
      if (E.isRight(result) && result.right) {
        return toDomainTeam(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await teamRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainTeam);
      }
      return [];
    },
  });

  const teamService = createTeamService(bootstrapApi, teamRepository, teamCache);

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.team.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      await multi.exec();

      // Sync teams from API
      await pipe(
        teamService.syncTeamsFromApi(),
        TE.fold<ServiceError, readonly Team[], void>(
          (error) => {
            console.error('Failed to sync teams:', error);
            return T.of(undefined);
          },
          () => T.of(void (async () => {})()),
        ),
      )();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      // Clean up test data
      await prisma.team.deleteMany();

      // Clean up test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      await multi.exec();

      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Service Setup', () => {
    it('should create service with proper interface', () => {
      expect(teamService).toBeDefined();
      expect(teamService.getTeams).toBeDefined();
      expect(teamService.getTeam).toBeDefined();
      expect(teamService.saveTeams).toBeDefined();
      expect(teamService.syncTeamsFromApi).toBeDefined();
      expect(teamService.workflows).toBeDefined();
      expect(teamService.workflows.syncTeams).toBeDefined();
    });
  });

  describe('Team Retrieval', () => {
    it(
      'should get all teams',
      async () => {
        const result = await pipe(
          teamService.getTeams(),
          TE.fold<ServiceError, readonly Team[], readonly Team[]>(
            () => T.of([]),
            (teams) => T.of(teams),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          shortName: expect.any(String),
          strength: expect.any(Number),
          strengthOverallHome: expect.any(Number),
          strengthOverallAway: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get team by id',
      async () => {
        // First get all teams to find a valid ID
        const teams = await pipe(
          teamService.getTeams(),
          TE.fold<ServiceError, readonly Team[], readonly Team[]>(
            () => T.of([]),
            (teams) => T.of(teams),
          ),
        )();

        expect(teams.length).toBeGreaterThan(0);
        const testTeam = teams[0];

        const result = await pipe(
          teamService.getTeam(testTeam.id),
          TE.map((team: Team | null): O.Option<Team> => O.fromNullable(team)),
          TE.fold<ServiceError, O.Option<Team>, O.Option<Team>>(
            () => T.of(O.none),
            (teamOption) => T.of(teamOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testTeam.id,
            name: expect.any(String),
            shortName: expect.any(String),
            strength: expect.any(Number),
            strengthOverallHome: expect.any(Number),
            strengthOverallAway: expect.any(Number),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent team id',
      async () => {
        const nonExistentId = 9999 as TeamId;
        const result = await pipe(
          teamService.getTeam(nonExistentId),
          TE.map((team: Team | null): O.Option<Team> => O.fromNullable(team)),
          TE.fold<ServiceError, O.Option<Team>, O.Option<Team>>(
            () => T.of(O.none),
            (teamOption) => T.of(teamOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Team Creation', () => {
    it(
      'should save teams',
      async () => {
        // First get all teams
        const existingTeams = await pipe(
          teamService.getTeams(),
          TE.fold<ServiceError, readonly Team[], readonly Team[]>(
            () => T.of([]),
            (teams) => T.of(teams),
          ),
        )();

        expect(existingTeams.length).toBeGreaterThan(0);

        // Create new teams with different IDs
        const newTeams = existingTeams.slice(0, 2).map((team) => ({
          ...team,
          id: (team.id + 1000) as TeamId, // Avoid ID conflicts
        }));

        const result = await pipe(
          teamService.saveTeams(newTeams),
          TE.fold<ServiceError, readonly Team[], readonly Team[]>(
            () => T.of([]),
            (teams) => T.of(teams),
          ),
        )();

        expect(result.length).toBe(newTeams.length);
        expect(result[0]).toMatchObject({
          id: newTeams[0].id,
          name: expect.any(String),
          shortName: expect.any(String),
          strength: expect.any(Number),
          strengthOverallHome: expect.any(Number),
          strengthOverallAway: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
