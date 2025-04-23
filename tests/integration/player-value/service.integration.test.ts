import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { createPlayerCache } from '../../../src/domains/player/cache';
import { PlayerCache } from '../../../src/domains/player/types';
import { createPlayerValueCache } from '../../../src/domains/player-value/cache';
import { PlayerValueCache } from '../../../src/domains/player-value/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache } from '../../../src/domains/team/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { PlayerValueRepository } from '../../../src/repositories/player-value/type';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
import { playerValueWorkflows } from '../../../src/services/player-value/workflow';
import { PlayerId } from '../../../src/types/domain/player.type';
import { TeamId } from '../../../src/types/domain/team.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('PlayerValue Integration Tests', { timeout: 30000 }, () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let playerValueService: PlayerValueService;
  // Event dependencies
  let eventCache: EventCache;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const eventCachePrefix = CachePrefix.EVENT;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    // No local redis assignment
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    fplDataService = createFplBootstrapDataService(httpClient, logger);

    // Initialize repositories (needed for services and caches)
    playerValueRepository = createPlayerValueRepository(prisma);

    // Initialize caches
    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
    });
    playerCache = createPlayerCache({
      keyPrefix: playerCachePrefix,
      season: season,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
    });
    playerValueCache = createPlayerValueCache({
      keyPrefix: cachePrefix,
      ttlSeconds: 3600,
      season: season,
    });

    // Initialize PlayerValue service (depends on caches being potentially populated)
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
    await prisma.playerValue.deleteMany({});

    // Use shared client for cleanup
    const valueKeys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (valueKeys.length > 0) {
      await redisClient.del(valueKeys);
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  describe('PlayerValue Service Integration', () => {
    it('should fetch player values from API, store in database, and cache them', async () => {
      // Base data is already synced in beforeAll

      const syncResult = await playerValueService.syncPlayerValuesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);

      const dbValues = await prisma.playerValue.findMany();
      expect(dbValues.length).toBeGreaterThan(0);
    });

    it('should get player value by ID after syncing', async () => {
      // Sync first to ensure data exists
      // Base data is already synced in beforeAll

      // We still need to sync player values here if the test relies on recent sync results
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // Fetch all from DB to get a valid element ID for testing
      const dbValues = await prisma.playerValue.findMany();
      expect(dbValues.length).toBeGreaterThan(0);
      // Get the first value's elementId for subsequent tests
      const targetElementId = dbValues[0].elementId;
      const targetPlayerValue = dbValues[0]; // Get the full record for comparison

      // Attempting to fetch using the element ID
      const valueResult = await playerValueService.getPlayerValuesByElement(
        targetElementId as PlayerId,
      )();

      expect(E.isRight(valueResult)).toBe(true);
      if (E.isRight(valueResult)) {
        const values = valueResult.right; // Type is PlayerValues (ReadonlyArray<PlayerValue>)
        expect(values.length).toBeGreaterThan(0);
        const fetchedValue = values[0]; // Get the first result

        // Basic check
        expect(fetchedValue.elementId).toEqual(targetElementId);

        // Check properties specific to PlayerValue (including those added by enrichment and change detection)
        expect(fetchedValue).toHaveProperty('elementId');
        expect(fetchedValue).toHaveProperty('value');
        expect(fetchedValue).toHaveProperty('lastValue'); // Added property
        expect(fetchedValue).toHaveProperty('changeType'); // Added property
        expect(fetchedValue).toHaveProperty('changeDate');
        // Check enriched properties (assuming enrichment works)
        expect(fetchedValue).toHaveProperty('elementType');
        expect(fetchedValue).toHaveProperty('elementTypeName');
        expect(fetchedValue).toHaveProperty('teamId');
        expect(fetchedValue).toHaveProperty('teamName');
        expect(fetchedValue).toHaveProperty('teamShortName');

        // Optionally, compare specific calculated values if deterministic
        // Note: changeType might be 'Start' on the very first sync
        expect(fetchedValue.lastValue).toBeDefined();
        expect(fetchedValue.changeType).toBeDefined();

        // Can compare against the value fetched directly from DB if needed
        // Adjust assertion to compare service float with DB int / 10
        expect(fetchedValue.value).toEqual(targetPlayerValue.value / 10);
        // lastValue might differ depending on test setup and previous runs
      }
    });

    it('should get player values by team after syncing', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // Fetch a PlayerValue from DB to get an element ID
      const dbValue = await prisma.playerValue.findFirst();
      expect(dbValue).not.toBeNull();
      if (!dbValue) throw new Error('No player value found in DB after sync');

      // Fetch the corresponding Player using the element ID to get the teamId
      const player = await prisma.player.findUnique({
        where: { id: dbValue.elementId },
      });
      expect(player).not.toBeNull();
      if (!player) throw new Error(`No player found for element ${dbValue.elementId}`);
      const targetTeamId = player.teamId;

      const valuesByTeamResult = await playerValueService.getPlayerValuesByTeam(
        targetTeamId as TeamId,
      )();
      expect(E.isRight(valuesByTeamResult)).toBe(true);

      if (E.isRight(valuesByTeamResult)) {
        const values = valuesByTeamResult.right;
        // It's possible a team has no players with value changes, so check array but not necessarily length > 0
        expect(Array.isArray(values)).toBe(true);

        if (values.length > 0) {
          values.forEach((v) => {
            expect(v.teamId).toEqual(targetTeamId);
            // Check enrichment
            expect(v).toHaveProperty('teamName');
            expect(v).toHaveProperty('teamShortName');
            // Check change info
            expect(v).toHaveProperty('lastValue');
            expect(v).toHaveProperty('changeType');
          });
        }
      }
    });

    it('should get player values by change date after syncing', async () => {
      const syncResult = await playerValueService.syncPlayerValuesFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      // Get today's date in YYYY-MM-DD format for the test
      const today = new Date();
      const changeDateToTest = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      // Fetch using the change date
      const valuesByDateResult =
        await playerValueService.getPlayerValuesByChangeDate(changeDateToTest)();
      expect(E.isRight(valuesByDateResult)).toBe(true);

      if (E.isRight(valuesByDateResult)) {
        const values = valuesByDateResult.right;
        // It's possible no values changed today, so we check the result is an array
        // but not necessarily non-empty
        expect(Array.isArray(values)).toBe(true);

        // If values exist, check their structure and date
        if (values.length > 0) {
          values.forEach((v) => {
            expect(v.changeDate).toEqual(changeDateToTest);
            // Check enrichment
            expect(v).toHaveProperty('elementTypeName');
            expect(v).toHaveProperty('teamName');
            // Check change info
            expect(v).toHaveProperty('lastValue');
            expect(v).toHaveProperty('changeType');
          });
        }
        // If no values changed, the test still passes as the function returned Right<[]>
      }
    });
  });

  describe('PlayerValue Workflow Integration', () => {
    it('should execute the sync player values workflow end-to-end', async () => {
      // Ensure events are synced first if workflow depends on it
      // Base data is already synced in beforeAll

      const workflows = playerValueWorkflows(playerValueService);
      const result = await workflows.syncPlayerValues()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        // Check WorkflowResult properties
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toEqual('player-value-sync');
        expect(result.right.duration).toBeGreaterThan(0);

        // Verify side effect: data should be in the database
        const dbValues = await prisma.playerValue.findMany();
        expect(dbValues.length).toBeGreaterThan(0);
      }
    });
  });
});
