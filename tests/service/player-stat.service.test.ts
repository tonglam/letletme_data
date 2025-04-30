import { createEventCache } from 'domain/event/cache';
import { EventCache } from 'domain/event/types';
import { createPlayerCache } from 'domain/player/cache';
import { PlayerCache } from 'domain/player/types';
import { createPlayerStatCache } from 'domain/player-stat/cache';
import { PlayerStatCache } from 'domain/player-stat/types';
import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { FplBootstrapDataService } from 'data/types';
import { db } from 'db/index';
import * as playerStatSchema from 'db/schema/player-stat';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createPlayerStatRepository } from 'repository/player-stat/repository';
import { PlayerStatRepository } from 'repository/player-stat/types';
import { createPlayerStatService } from 'service/player-stat/service';
import { PlayerStatService } from 'service/player-stat/types';
import { playerStatWorkflows } from 'service/player-stat/workflow';
import { IntegrationTestSetupResult, setupIntegrationTest } from 'tests/setup/integrationTestSetup';
import { ElementTypeId } from 'types/base.type';

type DrizzleDB = typeof db;

describe('PlayerStat Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let drizzleDb: DrizzleDB;
  let logger: Logger;
  let fplDataService: FplBootstrapDataService;
  let playerStatRepository: PlayerStatRepository;
  let playerStatCache: PlayerStatCache;
  let playerStatService: PlayerStatService;
  let eventCache: EventCache;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;

  const cachePrefix = CachePrefix.PLAYER_STAT;
  const eventCachePrefix = CachePrefix.EVENT;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    drizzleDb = setup.db;
    logger = setup.logger;

    try {
      await redisClient.ping();
      logger.info('Shared redisClient ping successful.');
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    fplDataService = createFplBootstrapDataService();

    playerCache = createPlayerCache({
      keyPrefix: playerCachePrefix,
      season,
      ttlSeconds: DefaultTTL.PLAYER,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season,
      ttlSeconds: DefaultTTL.EVENT,
    });

    await eventCache.getAllEvents()();
    await playerCache.getAllPlayers()();
    await teamCache.getAllTeams()();

    playerStatRepository = createPlayerStatRepository();
    playerStatCache = createPlayerStatCache({
      keyPrefix: cachePrefix,
      season,
      ttlSeconds: DefaultTTL.PLAYER_STAT,
    });
    playerStatService = createPlayerStatService(
      fplDataService,
      playerStatRepository,
      playerStatCache,
      eventCache,
      teamCache,
      playerCache,
    );
  });

  describe('PlayerStat Service Integration', () => {
    it('should fetch player stats from API, store in database, and cache them', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      if (E.isLeft(syncResult)) {
        logger.error({ error: syncResult.left }, 'Sync operation failed unexpectedly.');
      }
      expect(E.isRight(syncResult)).toBe(true);

      const latestStatsResult = await playerStatService.getPlayerStats()();
      if (E.isLeft(latestStatsResult)) {
        logger.error(
          { error: latestStatsResult.left },
          'getLatestPlayerStats failed unexpectedly.',
        );
      }
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult)) {
        const playerStats = latestStatsResult.right;
        expect(playerStats.length).toBeGreaterThan(0);
        const firstStat = playerStats[0];

        expect(firstStat).toHaveProperty('elementId');
        expect(firstStat).toHaveProperty('eventId');
        expect(firstStat).toHaveProperty('minutes');
        expect(firstStat).toHaveProperty('elementType');
        expect(firstStat).toHaveProperty('elementTypeName');
        expect(firstStat).toHaveProperty('teamId');
        expect(firstStat).toHaveProperty('teamName');
        expect(firstStat).toHaveProperty('teamShortName');
      }

      const dbStats = await drizzleDb.select().from(playerStatSchema.playerStats);
      expect(dbStats.length).toBeGreaterThan(0);
    });

    it('should get player stat by ID after syncing', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      if (E.isLeft(syncResult)) {
        logger.error({ error: syncResult.left }, 'Sync operation failed unexpectedly.');
      }
      expect(E.isRight(syncResult)).toBe(true);

      const latestStatsResult = await playerStatService.getPlayerStats()();
      if (E.isLeft(latestStatsResult)) {
        logger.error(
          { error: latestStatsResult.left },
          'getLatestPlayerStats failed unexpectedly.',
        );
      }
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult)) {
        const stats = latestStatsResult.right;
        expect(stats.length).toBeGreaterThan(0);
        const firstStatElement = stats[0].elementId;
        const statResult = await playerStatService.getPlayerStat(firstStatElement)();

        if (E.isLeft(statResult)) {
          logger.error({ error: statResult.left }, 'getPlayerStat failed unexpectedly.');
        }
        expect(E.isRight(statResult)).toBe(true);

        if (E.isRight(statResult) && statResult.right) {
          expect(statResult.right.elementId).toEqual(firstStatElement);
          expect(statResult.right).toHaveProperty('elementType');
          expect(statResult.right).toHaveProperty('teamName');
        } else {
          throw new Error(
            `getPlayerStat returned Right(null) or test failed for element ${firstStatElement}`,
          );
        }
      } else {
        throw new Error('getLatestPlayerStats failed or returned empty array');
      }
    });

    it('should get player stats by element type after syncing', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      if (E.isLeft(syncResult)) {
        logger.error({ error: syncResult.left }, 'Sync operation failed unexpectedly.');
      }
      expect(E.isRight(syncResult)).toBe(true);

      const latestStatsResult = await playerStatService.getPlayerStats()();
      if (E.isLeft(latestStatsResult)) {
        logger.error(
          { error: latestStatsResult.left },
          'getLatestPlayerStats failed unexpectedly.',
        );
      }
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult) && latestStatsResult.right.length > 0) {
        const firstStat = latestStatsResult.right[0];
        const elementTypeToTest = firstStat.elementType;

        const statsByTypeResult = await playerStatService.getPlayerStatsByElementType(
          elementTypeToTest as ElementTypeId,
        )();
        if (E.isLeft(statsByTypeResult)) {
          logger.error(
            { error: statsByTypeResult.left },
            'getPlayerStatsByElementType failed unexpectedly.',
          );
        }
        expect(E.isRight(statsByTypeResult)).toBe(true);

        if (E.isRight(statsByTypeResult)) {
          const stats = statsByTypeResult.right;
          expect(stats.length).toBeGreaterThan(0);
          stats.forEach((s) => {
            expect(s.elementType).toEqual(elementTypeToTest);
            expect(s).toHaveProperty('elementTypeName');
          });
        } else {
          throw new Error('getPlayerStatsByElementType returned Left despite passing expect');
        }
      } else {
        throw new Error('Could not get latest stats or stats list is empty after sync.');
      }
    });

    it('should get player stats by team after syncing', async () => {
      const syncResult = await playerStatService.syncPlayerStatsFromApi()();
      if (E.isLeft(syncResult)) {
        logger.error({ error: syncResult.left }, 'Sync operation failed unexpectedly.');
      }
      expect(E.isRight(syncResult)).toBe(true);

      const latestStatsResult = await playerStatService.getPlayerStats()();
      if (E.isLeft(latestStatsResult)) {
        logger.error(
          { error: latestStatsResult.left },
          'getLatestPlayerStats failed unexpectedly.',
        );
      }
      expect(E.isRight(latestStatsResult)).toBe(true);

      if (E.isRight(latestStatsResult) && latestStatsResult.right.length > 0) {
        const firstStat = latestStatsResult.right[0];
        const teamToTest = firstStat.teamId;

        const statsByTeamResult = await playerStatService.getPlayerStatsByTeam(teamToTest)();
        if (E.isLeft(statsByTeamResult)) {
          logger.error(
            { error: statsByTeamResult.left },
            'getPlayerStatsByTeam failed unexpectedly.',
          );
        }
        expect(E.isRight(statsByTeamResult)).toBe(true);

        if (E.isRight(statsByTeamResult)) {
          const stats = statsByTeamResult.right;
          expect(stats.length).toBeGreaterThan(0);
          stats.forEach((s) => {
            expect(s.teamId).toEqual(teamToTest);
            expect(s).toHaveProperty('teamName');
            expect(s).toHaveProperty('teamShortName');
          });
        } else {
          throw new Error('getPlayerStatsByTeam returned Left despite passing expect');
        }
      } else {
        throw new Error('Could not get latest stats or stats list is empty after sync.');
      }
    });
  });

  describe('PlayerStat Workflow Integration', () => {
    it('should execute the sync player stats workflow end-to-end', async () => {
      const workflows = playerStatWorkflows(playerStatService);
      const result = await workflows.syncPlayerStats()();

      if (E.isLeft(result)) {
        logger.error({ error: result.left }, 'Sync workflow failed unexpectedly.');
      }
      expect(E.isRight(result)).toBe(true);

      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);

        const dbStats = await drizzleDb.select().from(playerStatSchema.playerStats);
        expect(dbStats.length).toBeGreaterThan(0);
      }
    });
  });
});
