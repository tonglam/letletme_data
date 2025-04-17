import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiConfig } from '../../src/configs/api/api.config';
import { CachePrefix } from '../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../src/data/fpl/bootstrap.data';
import { createTeamCache } from '../../src/domains/team/cache';
import { TeamCache, TeamRepository } from '../../src/domains/team/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createTeamRepository } from '../../src/repositories/team/repository';
import { createTeamService } from '../../src/services/team/service';
import { TeamService } from '../../src/services/team/types';
import { teamWorkflows } from '../../src/services/team/workflow';
import { Teams } from '../../src/types/domain/team.type';

describe('Team Integration Tests', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let teamRepository: TeamRepository;
  let teamCache: TeamCache;
  let teamService: TeamService;
  let logger: pino.Logger;

  let bootstrapDataService: ReturnType<typeof createFplBootstrapDataService>;

  beforeAll(async () => {
    prisma = new PrismaClient();
    logger = pino({ level: 'info' });

    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
    });

    if (redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        redis.once('ready', () => resolve());
      });
    }

    const httpClient = createHTTPClient({
      client: axios.create({ baseURL: apiConfig.baseUrl }),
      retryConfig: {
        ...DEFAULT_RETRY_CONFIG,
        attempts: 3,
        baseDelay: 1000,
        maxDelay: 5000,
      },
      logger,
    });

    bootstrapDataService = createFplBootstrapDataService(httpClient, logger);

    teamRepository = createTeamRepository(prisma);
    teamCache = createTeamCache(teamRepository, {
      keyPrefix: CachePrefix.TEAM,
      season: '2425',
    });

    teamService = createTeamService(bootstrapDataService, teamRepository, teamCache);
  });

  beforeEach(async () => {
    await prisma.team.deleteMany({});
    const teamKeys = await redis.keys(`${CachePrefix.TEAM}::*`);
    if (teamKeys.length > 0) {
      await redis.del(teamKeys);
    }
    const testKeys = await redis.keys('test:*');
    if (testKeys.length > 0) {
      await redis.del(testKeys);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('Team Service Integration', () => {
    it('should fetch teams from API, store in database, and cache them', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const teams = syncResult.right as Teams;
        expect(Array.isArray(teams)).toBe(true);
        expect(teams.length).toBeGreaterThan(0);

        const firstTeam = teams[0];
        expect(firstTeam).toHaveProperty('id');
        expect(firstTeam).toHaveProperty('name');
        expect(firstTeam).toHaveProperty('shortName');
        expect(firstTeam).toHaveProperty('code');
      }

      const dbTeamsCount = await prisma.team.count();
      expect(dbTeamsCount).toBeGreaterThan(0);

      const cacheKey = `${CachePrefix.TEAM}::2425`;
      const keyExists = await redis.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should get team by ID after syncing', async () => {
      const syncResult = await teamService.syncTeamsFromApi()();

      if (E.isRight(syncResult)) {
        const teams = syncResult.right as Teams;
        if (teams.length > 0) {
          const firstTeamId = teams[0].id;
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
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(Array.isArray(result.right.result)).toBe(true);
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbTeamsCount = await prisma.team.count();
        expect(dbTeamsCount).toEqual(result.right.result.length);
      }
    });
  });
});
