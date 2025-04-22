import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
// Removed Redis import
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use the generic setup

// Import the SHARED redis client used by the application

// Specific imports for this test suite
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
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PlayerRepository } from '../../../src/repositories/player/type';
import { createPlayerValueRepository } from '../../../src/repositories/player-value/repository';
import { PlayerValueRepository } from '../../../src/repositories/player-value/type';
import { createTeamRepository } from '../../../src/repositories/team/repository';
import { TeamRepository } from '../../../src/repositories/team/type';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { createPlayerService } from '../../../src/services/player/service';
import { PlayerService } from '../../../src/services/player/types';
import { createPlayerValueService } from '../../../src/services/player-value/service';
import { PlayerValueService } from '../../../src/services/player-value/types';
import { playerValueWorkflows } from '../../../src/services/player-value/workflow';
import { createTeamService } from '../../../src/services/team/service';
import { TeamService } from '../../../src/services/team/types';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('PlayerValue Integration Tests', { timeout: 30000 }, () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  // Removed local redis
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerValueRepository: PlayerValueRepository;
  let playerValueCache: PlayerValueCache;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let playerValueService: PlayerValueService;
  // Event service dependencies
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let eventService: EventService;
  let playerService: PlayerService;
  let teamService: TeamService;

  const cachePrefix = CachePrefix.PLAYER_VALUE;
  const playerCachePrefix = CachePrefix.PLAYER;
  const teamCachePrefix = CachePrefix.TEAM;
  const eventCachePrefix = CachePrefix.EVENT;
  const testSeason = '2425';

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

    eventRepository = createEventRepository(prisma);
    // Event cache uses singleton client
    eventCache = createEventCache(eventRepository, {
      keyPrefix: eventCachePrefix,
      season: testSeason,
    });
    eventService = createEventService(fplDataService, eventRepository, eventCache);

    playerValueRepository = createPlayerValueRepository(prisma);
    // Initialize Player dependencies
    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache(playerRepository, {
      keyPrefix: playerCachePrefix,
      season: testSeason,
    });

    // Initialize PlayerService
    playerService = createPlayerService(fplDataService, playerRepository, playerCache);

    // Initialize Team dependencies
    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: teamCachePrefix,
      season: testSeason,
    });

    // Initialize TeamService
    teamService = createTeamService(fplDataService, teamRepository, teamCache);

    // PlayerValue cache uses singleton client
    playerValueCache = createPlayerValueCache({
      keyPrefix: cachePrefix,
      ttlSeconds: 3600,
    });
    playerValueService = createPlayerValueService(
      fplDataService,
      playerValueRepository,
      playerValueCache,
      eventCache,
      teamCache,
      playerCache,
    );

    // Sync base data once after all services are set up
    await teamService.syncTeamsFromApi()();
    await playerService.syncPlayersFromApi()();
    await eventService.syncEventsFromApi()();
  });

  beforeEach(async () => {
    await prisma.playerValue.deleteMany({});

    // Use shared client for cleanup
    const valueKeys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
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
      const targetElementId = dbValues[0].element;
      const targetPlayerValue = dbValues[0]; // Get the full record for comparison

      // Attempting to fetch using the element ID
      const valueResult = await playerValueService.getPlayerValuesByElement(targetElementId)();

      expect(E.isRight(valueResult)).toBe(true);
      if (E.isRight(valueResult)) {
        const values = valueResult.right; // Type is PlayerValues (ReadonlyArray<PlayerValue>)
        expect(values.length).toBeGreaterThan(0);
        const fetchedValue = values[0]; // Get the first result

        // Basic check
        expect(fetchedValue.element).toEqual(targetElementId);

        // Check properties specific to PlayerValue (including those added by enrichment and change detection)
        expect(fetchedValue).toHaveProperty('element');
        expect(fetchedValue).toHaveProperty('value');
        expect(fetchedValue).toHaveProperty('lastValue'); // Added property
        expect(fetchedValue).toHaveProperty('changeType'); // Added property
        expect(fetchedValue).toHaveProperty('changeDate');
        // Check enriched properties (assuming enrichment works)
        expect(fetchedValue).toHaveProperty('elementType');
        expect(fetchedValue).toHaveProperty('elementTypeName');
        expect(fetchedValue).toHaveProperty('team');
        expect(fetchedValue).toHaveProperty('teamName');
        expect(fetchedValue).toHaveProperty('teamShortName');

        // Optionally, compare specific calculated values if deterministic
        // Note: changeType might be 'Start' on the very first sync
        expect(fetchedValue.lastValue).toBeDefined();
        expect(fetchedValue.changeType).toBeDefined();

        // Can compare against the value fetched directly from DB if needed
        expect(fetchedValue.value).toEqual(targetPlayerValue.value);
        // lastValue might differ depending on test setup and previous runs
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
