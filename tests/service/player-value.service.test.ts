import { createEventCache } from 'domain/event/cache';
import { EventCache } from 'domain/event/types';
import { createPlayerCache } from 'domain/player/cache';
import { PlayerCache } from 'domain/player/types';
import { createPlayerValueCache } from 'domain/player-value/cache';
import { PlayerValueCache } from 'domain/player-value/types';
import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';

import { beforeEach, beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { FplBootstrapDataService } from 'data/types';
import { db } from 'db/index';
import * as playerSchema from 'db/schema/player';
import * as playerValueSchema from 'db/schema/player-value';
import { eq } from 'drizzle-orm';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createPlayerValueRepository } from 'repository/player-value/repository';
import { PlayerValueRepository } from 'repository/player-value/types';
import { createPlayerValueService } from 'service/player-value/service';
import { PlayerValueService } from 'service/player-value/types';
import { playerValueWorkflows } from 'service/player-value/workflow';
import { PlayerValue, PlayerValues } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

import { IntegrationTestSetupResult, setupIntegrationTest } from '../setup/integrationTestSetup';

type DrizzleDB = typeof db;

describe('PlayerValue Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let drizzleDb: DrizzleDB;
  let logger: Logger;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let eventCache: EventCache;
  let fplDataService: FplBootstrapDataService;
  let playerValueService: PlayerValueService;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const eventCachePrefix = CachePrefix.EVENT;
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

    playerValueRepository = createPlayerValueRepository();

    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.EVENT,
    });
    playerCache = createPlayerCache({
      keyPrefix: playerCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.PLAYER,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    playerValueCache = createPlayerValueCache({
      keyPrefix: cachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.PLAYER_VALUE,
    });

    playerValueService = createPlayerValueService(
      fplDataService,
      playerValueRepository,
      playerValueCache,
      eventCache,
      teamCache,
      playerCache,
    );
  });

  beforeEach(async () => {
    await drizzleDb.delete(playerValueSchema.playerValues);
    const valueKeys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (valueKeys.length > 0) {
      await redisClient.del(valueKeys);
    }
  });

  describe('PlayerValue Service Integration', () => {
    it('should fetch player values from API and complete sync successfully', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
    });

    it('should get player values by element ID after syncing', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const dbValues = await drizzleDb.select().from(playerValueSchema.playerValues);
      expect(dbValues.length).toBeGreaterThan(0);

      const targetDbValue = dbValues[0];
      const targetElementId = targetDbValue.elementId as PlayerId;

      const valueResult = await playerValueService.getPlayerValuesByElement(targetElementId)();

      expect(E.isRight(valueResult)).toBe(true);
      if (E.isRight(valueResult)) {
        const values = valueResult.right as PlayerValues;
        expect(values.length).toBeGreaterThan(0);
        const fetchedValue = values[0];

        expect(fetchedValue.elementId).toEqual(targetElementId);
        expect(fetchedValue).toHaveProperty('value');
        expect(fetchedValue).toHaveProperty('lastValue');
        expect(fetchedValue).toHaveProperty('changeType');
        expect(fetchedValue).toHaveProperty('changeDate');
        expect(fetchedValue).toHaveProperty('elementType');
        expect(fetchedValue).toHaveProperty('elementTypeName');
        expect(fetchedValue).toHaveProperty('teamId');
        expect(fetchedValue).toHaveProperty('teamName');
        expect(fetchedValue).toHaveProperty('teamShortName');

        expect(fetchedValue.value).toEqual(targetDbValue.value / 10);
        expect(fetchedValue.lastValue).toBeDefined();
        expect(fetchedValue.changeType).toBeDefined();
      }
    });

    it('should get player values by team after syncing', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const dbValueResult = await drizzleDb.select().from(playerValueSchema.playerValues).limit(1);
      expect(dbValueResult.length).toBeGreaterThan(0);

      if (dbValueResult.length === 0) throw new Error('No player value found in DB after sync');
      const dbValue = dbValueResult[0];

      const player = await drizzleDb
        .select()
        .from(playerSchema.players)
        .where(eq(playerSchema.players.id, dbValue.elementId))
        .limit(1);

      if (player.length === 0) throw new Error(`No player found for element ${dbValue.elementId}`);

      const targetTeamId = player[0].teamId as TeamId;
      const valuesByTeamResult = await playerValueService.getPlayerValuesByTeam(targetTeamId)();
      expect(E.isRight(valuesByTeamResult)).toBe(true);

      if (E.isRight(valuesByTeamResult)) {
        const values = valuesByTeamResult.right as PlayerValues;
        expect(Array.isArray(values)).toBe(true);

        if (values.length > 0) {
          values.forEach((v: PlayerValue) => {
            expect(v.teamId).toEqual(targetTeamId);
            expect(v).toHaveProperty('teamName');
            expect(v).toHaveProperty('teamShortName');
            expect(v).toHaveProperty('lastValue');
            expect(v).toHaveProperty('changeType');
          });
        }
      }
    });

    it('should get player values by change date after syncing', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const dbDates = await drizzleDb
        .selectDistinct({ changeDate: playerValueSchema.playerValues.changeDate })
        .from(playerValueSchema.playerValues)
        .orderBy(playerValueSchema.playerValues.changeDate)
        .limit(1);

      if (dbDates.length === 0) {
        logger.warn('No player value changes found in DB after sync, test might be inconclusive.');
        return;
      }

      const changeDateToTest = dbDates[0].changeDate;
      const valuesByDateResult =
        await playerValueService.getPlayerValuesByChangeDate(changeDateToTest)();
      expect(E.isRight(valuesByDateResult)).toBe(true);

      if (E.isRight(valuesByDateResult)) {
        const values = valuesByDateResult.right as PlayerValues;
        expect(Array.isArray(values)).toBe(true);

        if (values.length > 0) {
          values.forEach((v: PlayerValue) => {
            expect(v.changeDate).toEqual(changeDateToTest);
            expect(v).toHaveProperty('elementTypeName');
            expect(v).toHaveProperty('teamName');
            expect(v).toHaveProperty('lastValue');
            expect(v).toHaveProperty('changeType');
          });
        } else {
          logger.error(
            { changeDate: changeDateToTest },
            'Service returned no values for a change date found in the DB!',
          );
          expect(values.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('PlayerValue Workflow Integration', () => {
    it('should execute the sync player values workflow end-to-end', async () => {
      await drizzleDb.delete(playerValueSchema.playerValues);
      const valueKeys = await redisClient.keys(`${cachePrefix}::${season}*`);
      if (valueKeys.length > 0) await redisClient.del(valueKeys);

      const workflows = playerValueWorkflows(playerValueService);
      const result = await workflows.syncPlayerValues()();

      expect(E.isRight(result)).toBe(true);

      if (E.isRight(result)) {
        const workflowResult = result.right;
        expect(workflowResult.context).toBeDefined();
        expect(workflowResult.context.workflowId).toEqual('player-value-sync');
        expect(workflowResult.duration).toBeGreaterThan(0);

        const dbValues = await drizzleDb.select().from(playerValueSchema.playerValues);
        expect(dbValues.length).toBeGreaterThan(0);
      }
    });
  });
});
