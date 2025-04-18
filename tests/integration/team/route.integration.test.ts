import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Setup
import { redisClient } from '../../../src/infrastructures/cache/client';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

// Specific imports
import { teamRouter } from '../../../src/api/routes/team.route'; // Import the router
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/fetches/bootstrap/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createTeamCache } from '../../../src/domains/team/cache';
import { TeamCache, TeamRepository } from '../../../src/domains/team/types';
import { HTTPClient } from '../../../src/infrastructures/http/client';
import { createTeamRepository } from '../../../src/repositories/team/repository';
import { createTeamService } from '../../../src/services/team/service';
import { TeamService } from '../../../src/services/team/types';
import { Team, TeamId } from '../../../src/types/domain/team.type';

describe('Team Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let teamService: TeamService;

  const cachePrefix = CachePrefix.TEAM;
  const testSeason = '2425';

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

    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    teamService = createTeamService(fplDataService, teamRepository, teamCache);

    // Create Express app and mount only the team router
    app = express();
    app.use(express.json());
    app.use('/teams', teamRouter(teamService)); // Mount router
  });

  beforeEach(async () => {
    await prisma.team.deleteMany({});
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    // Ensure data exists for GET requests by syncing
    await teamService.syncTeamsFromApi()();
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /teams should return all teams within a data object', async () => {
    const res = await request(app).get('/teams');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const teams = res.body.data as Team[];
    expect(teams.length).toBeGreaterThan(0);
    expect(teams[0]).toHaveProperty('id');
    expect(teams[0]).toHaveProperty('name');
    expect(teams[0]).toHaveProperty('shortName');
  });

  it('GET /teams/:id should return the team within a data object', async () => {
    const allTeamsResult = await teamService.getTeams()();
    let targetTeamId: TeamId | null = null;
    if (E.isRight(allTeamsResult) && allTeamsResult.right && allTeamsResult.right.length > 0) {
      targetTeamId = allTeamsResult.right[0].id;
    } else {
      throw new Error('Could not retrieve teams to get an ID for testing');
    }

    const res = await request(app).get(`/teams/${targetTeamId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.id).toBe(targetTeamId);
    expect(res.body.data).toHaveProperty('name');
  });

  it('GET /teams/:id should return 404 if team ID does not exist', async () => {
    const nonExistentTeamId = 999 as TeamId;
    const res = await request(app).get(`/teams/${nonExistentTeamId}`);

    expect(res.status).toBe(404);
  });
});
