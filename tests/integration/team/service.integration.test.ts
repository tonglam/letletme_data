import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
// Removed Redis import
import { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Use the generic setup

// Import the SHARED redis client used by the application

// Specific imports for this test suite
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createTeamCache } from '../../../src/domains/team/cache'; // Team specific
import { TeamCache } from '../../../src/domains/team/types'; // Team specific
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createTeamRepository } from '../../../src/repositories/team/repository'; // Team specific
import { TeamRepository } from '../../../src/repositories/team/types'; // Import TeamRepository
import { createTeamService } from '../../../src/services/team/service'; // Team specific
import { TeamService } from '../../../src/services/team/types'; // Team specific
import { teamWorkflows } from '../../../src/services/team/workflow'; // Team specific
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

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

    teamRepository = createTeamRepository(prisma);
    // Team cache uses singleton client
    teamCache = createTeamCache({
      keyPrefix: cachePrefix,
      season: season,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    teamService = createTeamService(fplDataService, teamRepository, teamCache);
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // await redisClient.quit(); // If global teardown needed
  });

  describe('Team Service Integration', () => {
    it('should fetch teams from API, store in database, and cache them', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      // Check sync succeeded (Right<void>)
      expect(E.isRight(syncResult)).toBe(true);

      // Now check if teams were actually stored by fetching them
      const getTeamsResult = await teamService.getTeams()();
      expect(E.isRight(getTeamsResult)).toBe(true);
      if (E.isRight(getTeamsResult)) {
        const teams = getTeamsResult.right;
        expect(teams.length).toBeGreaterThan(0);
        const firstTeam = teams[0];
        expect(firstTeam).toHaveProperty('id');
        expect(firstTeam).toHaveProperty('name');
        expect(firstTeam).toHaveProperty('shortName');
      }

      // Check DB directly
      const dbTeams = await prisma.team.findMany();
      expect(dbTeams.length).toBeGreaterThan(0);

      // Check cache directly
      const cacheKey = `${cachePrefix}::${season}`;
      // Use shared client for check
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get team by ID after syncing', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Ensure sync completed successfully (Right<void>)

      // Fetch all teams to get a valid ID
      const getTeamsResult = await teamService.getTeams()();
      expect(E.isRight(getTeamsResult)).toBe(true);

      if (E.isRight(getTeamsResult)) {
        const teams = getTeamsResult.right;
        expect(teams.length).toBeGreaterThan(0); // Make sure we have teams to test with

        const firstTeamId = teams[0]?.id;
        if (firstTeamId === undefined) {
          throw new Error('First team or its ID is undefined after sync');
        }
        const teamResult = await teamService.getTeam(firstTeamId)();

        expect(E.isRight(teamResult)).toBe(true);
        if (E.isRight(teamResult)) {
          // Check Right<Team> explicitly
          expect(teamResult.right).toBeDefined();
          expect(teamResult.right.id).toEqual(firstTeamId);
        } else {
          // Fail test if teamResult is Left
          throw new Error(`Expected Right but got Left: ${JSON.stringify(teamResult.left)}`);
        }
      } else {
        // Fail test if getTeamsResult is Left
        throw new Error(
          `Expected Right but got Left when getting teams: ${JSON.stringify(getTeamsResult.left)}`,
        );
      }
    });
  });

  describe('Team Workflow Integration', () => {
    it('should execute the sync teams workflow end-to-end', async () => {
      const workflows = teamWorkflows(teamService);
      const result = await workflows.syncTeams()();

      expect(E.isRight(result)).toBe(true); // Check workflow completed successfully
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        // WorkflowResult doesn't contain the void result, just context/duration

        // Verify side effect: check database
        const dbTeams = await prisma.team.findMany();
        expect(dbTeams.length).toBeGreaterThan(0); // Check that teams were actually synced
      } else {
        // Fail test if workflow result is Left
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
