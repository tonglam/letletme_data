import { PrismaClient } from '@prisma/client';
import { createTeamCache } from 'domains/team/cache';
import { TeamCache } from 'domains/team/types';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPlayerCache } from '../../../src/domains/player/cache';
import { PlayerCache } from '../../../src/domains/player/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PlayerRepository } from '../../../src/repositories/player/type';
import { createPlayerService } from '../../../src/services/player/service';
import { PlayerService } from '../../../src/services/player/types';
import { playerWorkflows } from '../../../src/services/player/workflow';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Player Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let fplDataService: FplBootstrapDataService;
  let playerService: PlayerService;
  let teamCache: TeamCache;

  const cachePrefix = CachePrefix.PLAYER;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
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
    playerCache = createPlayerCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    teamCache = createTeamCache({
      keyPrefix: CachePrefix.TEAM,
      season: season,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    playerService = createPlayerService(fplDataService, playerRepository, playerCache, teamCache);
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  describe('Player Service Integration', () => {
    it('should fetch players from API, store in database, and cache them', async () => {
      await prisma.player.deleteMany();

      const syncResult = await playerService.syncPlayersFromApi()();

      // Check sync succeeded (Right<void>)
      expect(E.isRight(syncResult)).toBe(true);

      // Now check if players were actually stored by fetching them
      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      if (E.isRight(getPlayersResult)) {
        const players = getPlayersResult.right;
        expect(players.length).toBeGreaterThan(0);
        const firstPlayer = players[0];
        expect(firstPlayer).toHaveProperty('firstName');
        expect(firstPlayer).toHaveProperty('secondName');
        expect(firstPlayer).toHaveProperty('webName');
      }

      // Check DB directly
      const dbPlayers = await prisma.player.findMany();
      expect(dbPlayers.length).toBeGreaterThan(0);
    });

    it('should get player by ID after syncing', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync completed successfully (Right<void>)

      // Fetch all players to get a valid ID
      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);

      if (E.isRight(getPlayersResult)) {
        const players = getPlayersResult.right;
        expect(players.length).toBeGreaterThan(0); // Make sure we have players to test with

        const firstPlayerId = players[0]?.id;
        if (firstPlayerId === undefined) {
          throw new Error('First player or its ID is undefined after sync');
        }
        const playerResult = await playerService.getPlayer(firstPlayerId)();

        expect(E.isRight(playerResult)).toBe(true);
        if (E.isRight(playerResult)) {
          // Check Right<Player> explicitly
          expect(playerResult.right).toBeDefined();
          expect(playerResult.right.id).toEqual(firstPlayerId);
        } else {
          // Fail test if playerResult is Left
          throw new Error(`Expected Right but got Left: ${JSON.stringify(playerResult.left)}`);
        }
      } else {
        // Fail test if getPlayersResult is Left
        throw new Error(
          `Expected Right but got Left when getting players: ${JSON.stringify(getPlayersResult.left)}`,
        );
      }
    });

    it('should get players by element type after syncing', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      if (E.isRight(getPlayersResult) && getPlayersResult.right.length > 0) {
        const firstPlayer = getPlayersResult.right[0];
        const elementTypeToTest = firstPlayer.type;

        const playersByTypeResult =
          await playerService.getPlayersByElementType(elementTypeToTest)();
        expect(E.isRight(playersByTypeResult)).toBe(true);
        if (E.isRight(playersByTypeResult)) {
          const players = playersByTypeResult.right;
          expect(players.length).toBeGreaterThan(0);
          // Verify all returned players have the correct element type
          players.forEach((p) => {
            expect(p.type).toEqual(elementTypeToTest);
          });
        }
      } else {
        throw new Error('Could not get players or player list is empty after sync.');
      }
    });

    it('should get players by team after syncing', async () => {
      const syncResult = await playerService.syncPlayersFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      if (E.isRight(getPlayersResult) && getPlayersResult.right.length > 0) {
        const firstPlayer = getPlayersResult.right[0];
        const teamToTest = firstPlayer.teamId;

        const playersByTeamResult = await playerService.getPlayersByTeam(teamToTest)();
        expect(E.isRight(playersByTeamResult)).toBe(true);
        if (E.isRight(playersByTeamResult)) {
          const players = playersByTeamResult.right;
          expect(players.length).toBeGreaterThan(0);
          // Verify all returned players belong to the correct team
          players.forEach((p) => {
            expect(p.teamId).toEqual(teamToTest);
          });
        }
      } else {
        throw new Error('Could not get players or player list is empty after sync.');
      }
    });
  });

  describe('Player Workflow Integration', () => {
    it('should execute the sync players workflow end-to-end', async () => {
      const workflows = playerWorkflows(playerService);
      const result = await workflows.syncPlayers()();

      expect(E.isRight(result)).toBe(true); // Check workflow completed successfully
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        // WorkflowResult doesn't contain the void result, just context/duration

        // Verify side effect: check database
        const dbPlayers = await prisma.player.findMany();
        expect(dbPlayers.length).toBeGreaterThan(0); // Check that players were actually synced
      } else {
        // Fail test if workflow result is Left
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
