import { createPlayerCache } from 'domain/player/cache';
import { PlayerCache } from 'domain/player/types';
import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { FplBootstrapDataService } from 'data/types';
import { db } from 'db/index';
import * as playerSchema from 'db/schema/player';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createPlayerRepository } from 'repository/player/repository';
import { PlayerRepository } from 'repository/player/types';
import { createPlayerService } from 'service/player/service';
import { PlayerService } from 'service/player/types';
import { playerWorkflows } from 'service/player/workflow';
import { ElementTypeId } from 'types/base.type';
import { Player, Players } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

import { IntegrationTestSetupResult, setupIntegrationTest } from '../setup/integrationTestSetup';

type DrizzleDB = typeof db;

describe('Player Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let drizzleDb: DrizzleDB;
  let logger: Logger;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let playerService: PlayerService;

  const cachePrefix = CachePrefix.PLAYER;
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

    playerRepository = createPlayerRepository();
    playerCache = createPlayerCache({
      keyPrefix: cachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.PLAYER,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    fplDataService = createFplBootstrapDataService();
    playerService = createPlayerService(fplDataService, playerRepository, playerCache, teamCache);
  });

  describe('Player Service Integration', () => {
    it('should fetch players from API, store in database, and cache them', async () => {
      await drizzleDb.delete(playerSchema.players);
      await redisClient.del(`${cachePrefix}::${season}`);

      const syncResult = await playerService.syncPlayersFromApi()();
      expect(E.isRight(syncResult)).toBe(true);

      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      if (E.isRight(getPlayersResult)) {
        const players = getPlayersResult.right as Players;
        expect(players.length).toBeGreaterThan(0);
        const firstPlayer = players[0];
        expect(firstPlayer).toHaveProperty('firstName');
        expect(firstPlayer).toHaveProperty('secondName');
        expect(firstPlayer).toHaveProperty('webName');
      } else {
        throw new Error(`getPlayers failed: ${JSON.stringify(getPlayersResult.left)}`);
      }

      // Check DB directly using Drizzle
      const dbPlayers = await drizzleDb.select().from(playerSchema.players);
      expect(dbPlayers.length).toBeGreaterThan(0);

      // Check cache
      const cacheKey = `${cachePrefix}::${season}`;
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get player by ID after syncing', async () => {
      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);

      if (E.isRight(getPlayersResult)) {
        const players = getPlayersResult.right as Players;
        expect(players.length).toBeGreaterThan(0);

        const firstPlayerId = players[0]?.id;
        if (firstPlayerId === undefined) {
          throw new Error('First player or its ID is undefined after sync');
        }
        const playerResult = await playerService.getPlayer(firstPlayerId)();

        expect(E.isRight(playerResult)).toBe(true);
        if (E.isRight(playerResult)) {
          const player = playerResult.right as Player;
          expect(player).toBeDefined();
          expect(player.id).toEqual(firstPlayerId);
        } else {
          throw new Error(`Expected Right but got Left: ${JSON.stringify(playerResult.left)}`);
        }
      } else {
        throw new Error(
          `Expected Right but got Left when getting players: ${JSON.stringify(getPlayersResult.left)}`,
        );
      }
    });

    it('should get players by element type after syncing', async () => {
      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      const playersList = E.isRight(getPlayersResult) ? (getPlayersResult.right as Players) : [];

      if (playersList.length > 0) {
        const firstPlayer = playersList[0];
        const elementTypeToTest: ElementTypeId = firstPlayer.type;

        const playersByTypeResult =
          await playerService.getPlayersByElementType(elementTypeToTest)();
        expect(E.isRight(playersByTypeResult)).toBe(true);
        if (E.isRight(playersByTypeResult)) {
          const players = playersByTypeResult.right as Players;
          expect(players.length).toBeGreaterThan(0);
          players.forEach((p: Player) => {
            expect(p.type).toEqual(elementTypeToTest);
          });
        }
      } else {
        throw new Error('Could not get players or player list is empty after sync.');
      }
    });

    it('should get players by team after syncing', async () => {
      const getPlayersResult = await playerService.getPlayers()();
      expect(E.isRight(getPlayersResult)).toBe(true);
      const playersList = E.isRight(getPlayersResult) ? (getPlayersResult.right as Players) : [];

      if (playersList.length > 0) {
        const firstPlayer = playersList[0];
        const teamToTest: TeamId = firstPlayer.teamId;

        const playersByTeamResult = await playerService.getPlayersByTeamId(teamToTest)();
        expect(E.isRight(playersByTeamResult)).toBe(true);
        if (E.isRight(playersByTeamResult)) {
          const players = playersByTeamResult.right as Players;
          expect(players.length).toBeGreaterThan(0);
          players.forEach((p: Player) => {
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
      await drizzleDb.delete(playerSchema.players);
      await redisClient.del(`${cachePrefix}::${season}`);

      const workflows = playerWorkflows(playerService);
      const result = await workflows.syncPlayers()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const workflowResult = result.right;
        expect(workflowResult).toBeDefined();

        const dbPlayers = await drizzleDb.select().from(playerSchema.players);
        expect(dbPlayers.length).toBeGreaterThan(0);
      } else {
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
