import { PrismaClient } from '@prisma/client';
import { createTeamCache } from 'domains/team/cache';
import { TeamCache } from 'domains/team/types';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Setup

// Specific imports
import { playerRouter } from '../../../src/api/player/route'; // Import the router
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
import { Player, PlayerId } from '../../../src/types/domain/player.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Player Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerRepository: PlayerRepository;
  let playerCache: PlayerCache;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let playerService: PlayerService;

  const cachePrefix = CachePrefix.PLAYER;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    playerRepository = createPlayerRepository(prisma);
    playerCache = createPlayerCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    teamCache = createTeamCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    playerService = createPlayerService(fplDataService, playerRepository, playerCache, teamCache);

    // Create Express app and mount only the player router
    app = express();
    app.use(express.json());
    app.use('/players', playerRouter(playerService)); // Mount router
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /players should return all players within a data object', async () => {
    const res = await request(app).get('/players');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const players = res.body.data as Player[];
    expect(players.length).toBeGreaterThan(0);
    expect(players[0]).toHaveProperty('element');
    expect(players[0]).toHaveProperty('webName');
  });

  it('GET /players/:id should return the player with the specified ID', async () => {
    const allPlayersResult = await playerService.getPlayers()();
    let targetPlayerId: PlayerId | null = null;
    if (
      E.isRight(allPlayersResult) &&
      allPlayersResult.right &&
      allPlayersResult.right.length > 0
    ) {
      targetPlayerId = allPlayersResult.right[0].id;
    } else {
      throw new Error('Could not retrieve players to get an ID for testing');
    }

    const res = await request(app).get(`/players/${String(targetPlayerId)}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.element).toBe(targetPlayerId);
    expect(res.body.data).toHaveProperty('webName');
  });

  it('GET /players/:id should return 404 if player ID does not exist', async () => {
    const nonExistentPlayerId = 99999 as PlayerId;
    const res = await request(app).get(`/players/${String(nonExistentPlayerId)}`);
    expect(res.status).toBe(404);
  });

  it('POST /players/sync should trigger synchronization and return success', async () => {
    // Clear cache and DB before testing sync specifically
    await prisma.player.deleteMany({});
    const keys = await redisClient.keys(`${cachePrefix}::${season}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    const res = await request(app).post('/players/sync');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The handler returns void on success, resulting in an empty body

    // Verify data was actually synced
    const playersInDb = await prisma.player.findMany();
    expect(playersInDb.length).toBeGreaterThan(0);
  });
});
