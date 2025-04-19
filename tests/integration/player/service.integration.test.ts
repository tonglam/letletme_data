import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
// Removed Redis import
import { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Use the generic setup
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Import the SHARED redis client used by the application
import { redisClient } from '../../../src/infrastructures/cache/client';

// Specific imports for this test suite
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPlayerCache } from '../../../src/domains/player/cache'; // Player specific
import { PlayerCache, PlayerRepository } from '../../../src/domains/player/types'; // Player specific
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPlayerRepository } from '../../../src/repositories/player/repository'; // Player specific
import { createPlayerService } from '../../../src/services/player/service'; // Player specific
import { PlayerService } from '../../../src/services/player/types'; // Player specific
import { playerWorkflows } from '../../../src/services/player/workflow'; // Player specific

describe('Player Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  // Removed local redis
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let fplDataService: FplBootstrapDataService;
  let playerService: PlayerService;

  const cachePrefix = CachePrefix.PLAYER;
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

    playerRepository = createPlayerRepository(prisma);
    // Player cache uses singleton client
    playerCache = createPlayerCache(playerRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    playerService = createPlayerService(fplDataService, playerRepository, playerCache);
  });

  beforeEach(async () => {
    await prisma.player.deleteMany({});
    // Use shared client for cleanup
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  describe('Player Service Integration', () => {
    it('should fetch players from API, store in database, and cache them', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const players = syncResult.right;
        expect(players.length).toBeGreaterThan(0);
        const firstPlayer = players[0];
        expect(firstPlayer).toHaveProperty('id');
        expect(firstPlayer).toHaveProperty('firstName');
        expect(firstPlayer).toHaveProperty('secondName');
        expect(firstPlayer).toHaveProperty('webName');
      }

      const dbPlayers = await prisma.player.findMany();
      expect(dbPlayers.length).toBeGreaterThan(0);

      const cacheKey = `${cachePrefix}::${testSeason}`;
      // Use shared client for check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get player by ID after syncing', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();

      if (E.isRight(syncResult)) {
        const players = syncResult.right;
        if (players.length > 0) {
          const firstPlayerId = players[0]?.element;
          if (firstPlayerId === undefined) {
            throw new Error('First player or its ID is undefined after sync');
          }
          const playerResult = await playerService.getPlayer(firstPlayerId)();

          expect(E.isRight(playerResult)).toBe(true);
          if (E.isRight(playerResult) && playerResult.right) {
            expect(playerResult.right.element).toEqual(firstPlayerId);
          }
        }
      }
    });
  });

  describe('Player Workflow Integration', () => {
    it('should execute the sync players workflow end-to-end', async () => {
      const workflows = playerWorkflows(playerService);
      const result = await workflows.syncPlayers()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbPlayers = await prisma.player.findMany();
        expect(dbPlayers.length).toEqual(result.right.result.length);
      }
    });
  });
});
