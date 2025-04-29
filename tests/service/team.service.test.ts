import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { FplBootstrapDataService } from 'data/types';
import { db } from 'db/index';
import * as teamSchema from 'db/schema/team';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createTeamRepository } from 'repository/team/repository';
import { TeamRepository } from 'repository/team/types';
import { createTeamService } from 'service/team/service';
import { TeamService } from 'service/team/types';
import { teamWorkflows } from 'service/team/workflow';
import { Team, Teams } from 'types/domain/team.type';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IntegrationTestSetupResult, setupIntegrationTest } from '../setup/integrationTestSetup';

type DrizzleDB = typeof db;

describe('Team Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let drizzleDb: DrizzleDB;
  let logger: Logger;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let fplDataService: FplBootstrapDataService;
  let teamService: TeamService;

  const cachePrefix = CachePrefix.TEAM;
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

    teamRepository = createTeamRepository();
    teamCache = createTeamCache({
      keyPrefix: cachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    fplDataService = createFplBootstrapDataService();
    teamService = createTeamService(fplDataService, teamRepository, teamCache);
  });

  afterAll(async () => {
    logger.info('Test teardown complete (manual steps if any).');
  });

  describe('Team Service Integration', () => {
    it('should fetch teams from API, store in database, and cache them', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      pipe(
        syncResult,
        E.fold(
          (error) => {
            logger.error({ error }, 'syncTeamsFromApi failed in test');
            throw new Error(`syncTeamsFromApi returned Left: ${JSON.stringify(error)}`);
          },
          () => {
            // Success case, do nothing here as the main logic continues below
          },
        ),
      );
      expect(E.isRight(syncResult)).toBe(true);

      const getTeamsResult = await teamService.getTeams()();
      expect(E.isRight(getTeamsResult)).toBe(true);
      if (E.isRight(getTeamsResult)) {
        const teams = getTeamsResult.right as Teams;
        expect(teams.length).toBeGreaterThan(0);
        const firstTeam = teams[0];
        expect(firstTeam).toHaveProperty('id');
        expect(firstTeam).toHaveProperty('name');
        expect(firstTeam).toHaveProperty('shortName');
      } else {
        throw new Error(`getTeams failed: ${JSON.stringify(getTeamsResult.left)}`);
      }

      const dbTeams = await drizzleDb.select().from(teamSchema.teams);
      expect(dbTeams.length).toBeGreaterThan(0);

      const cacheKey = `${cachePrefix}::${season}`;
      const keyExists = await redisClient.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get team by ID after syncing', async () => {
      const getTeamsResult = await teamService.getTeams()();
      expect(E.isRight(getTeamsResult)).toBe(true);

      if (E.isRight(getTeamsResult)) {
        const teams = getTeamsResult.right as Teams;
        expect(teams.length).toBeGreaterThan(0);

        const firstTeamId = teams[0]?.id;
        if (firstTeamId === undefined) {
          throw new Error('First team or its ID is undefined after sync');
        }
        const teamResult = await teamService.getTeam(firstTeamId)();

        expect(E.isRight(teamResult)).toBe(true);
        if (E.isRight(teamResult)) {
          const team = teamResult.right as Team;
          expect(team).toBeDefined();
          expect(team.id).toEqual(firstTeamId);
        } else {
          throw new Error(`Expected Right but got Left: ${JSON.stringify(teamResult.left)}`);
        }
      } else {
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

      pipe(result, (error) => {
        logger.error({ error }, 'syncTeams workflow failed in test');
        throw new Error(`syncTeams workflow returned Left: ${JSON.stringify(error)}`);
      });
      expect(E.isRight(result)).toBe(true);

      if (E.isRight(result)) {
        const workflowResult = result.right;
        expect(workflowResult).toBeDefined();

        const dbTeams = await drizzleDb.select().from(teamSchema.teams);
        expect(dbTeams.length).toBeGreaterThan(0);
      } else {
        throw new Error(`Workflow failed: ${JSON.stringify(result.left)}`);
      }
    });
  });
});
