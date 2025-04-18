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
import { createFplBootstrapDataService } from '../../../src/data/fpl/fetches/bootstrap/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createTeamCache } from '../../../src/domains/team/cache'; // Team specific
import { TeamCache, TeamRepository } from '../../../src/domains/team/types'; // Team specific
import { HTTPClient } from '../../../src/infrastructures/http/client';
import { createTeamRepository } from '../../../src/repositories/team/repository'; // Team specific
import { createTeamService } from '../../../src/services/team/service'; // Team specific
import { TeamService } from '../../../src/services/team/types'; // Team specific
import { teamWorkflows } from '../../../src/services/team/workflow'; // Team specific

describe('Team Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  // Removed local redis
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
    // No local redis assignment
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    teamRepository = createTeamRepository(prisma);
    // Team cache uses singleton client
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    teamService = createTeamService(fplDataService, teamRepository, teamCache);
  });

  beforeEach(async () => {
    await prisma.team.deleteMany({});
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

  describe('Team Service Integration', () => {
    it('should fetch teams from API, store in database, and cache them', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const teams = syncResult.right;
        expect(teams.length).toBeGreaterThan(0);
        const firstTeam = teams[0];
        expect(firstTeam).toHaveProperty('id');
        expect(firstTeam).toHaveProperty('name');
        expect(firstTeam).toHaveProperty('shortName');
      }

      const dbTeams = await prisma.team.findMany();
      expect(dbTeams.length).toBeGreaterThan(0);

      const cacheKey = `${cachePrefix}::${testSeason}`;
      // Use shared client for check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get team by ID after syncing', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      if (E.isRight(syncResult)) {
        const teams = syncResult.right;
        if (teams.length > 0) {
          const firstTeamId = teams[0]?.id;
          if (firstTeamId === undefined) {
            throw new Error('First team or its ID is undefined after sync');
          }
          const teamResult = await teamService.getTeam(firstTeamId)();

          expect(E.isRight(teamResult)).toBe(true);
          if (E.isRight(teamResult) && teamResult.right) {
            expect(teamResult.right.id).toEqual(firstTeamId);
          }
        }
      }
    });
  });

  describe('Team Workflow Integration', () => {
    it('should execute the sync teams workflow end-to-end', async () => {
      const workflows = teamWorkflows(teamService);
      const result = await workflows.syncTeams()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbTeams = await prisma.team.findMany();
        expect(dbTeams.length).toEqual(result.right.result.length);
      }
    });
  });
});
