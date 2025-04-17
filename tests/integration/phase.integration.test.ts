import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as E from 'fp-ts/Either';
import Redis from 'ioredis';
import pino from 'pino';

import { apiConfig } from '../../src/configs/api/api.config';
import { CachePrefix } from '../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../src/data/fpl/bootstrap.data';
import { createPhaseCache } from '../../src/domains/phase/cache';
import { PhaseCache, PhaseRepository } from '../../src/domains/phase/types';
import { createHTTPClient } from '../../src/infrastructures/http/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructures/http/client/utils';
import { createPhaseRepository } from '../../src/repositories/phase/repository';
import { createPhaseService } from '../../src/services/phase/service';
import { PhaseService } from '../../src/services/phase/types';
import { phaseWorkflows } from '../../src/services/phase/workflow';
import { Phases } from '../../src/types/domain/phase.type';

describe('Phase Integration Tests', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let phaseRepository: PhaseRepository;
  let phaseCache: PhaseCache;
  let phaseService: PhaseService;
  let logger: pino.Logger;

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

    const bootstrapDataService = createFplBootstrapDataService(httpClient, logger);
    phaseRepository = createPhaseRepository(prisma);
    phaseCache = createPhaseCache(phaseRepository, {
      keyPrefix: CachePrefix.PHASE,
      season: '2425',
    });
    phaseService = createPhaseService(bootstrapDataService, phaseRepository, phaseCache);
  });

  beforeEach(async () => {
    await prisma.phase.deleteMany({});
    const standardKeys = await redis.keys(`${CachePrefix.PHASE}::*`);
    if (standardKeys.length > 0) {
      await redis.del(standardKeys);
    }
    const testKeys = await redis.keys(`test:${CachePrefix.PHASE}::*`);
    if (testKeys.length > 0) {
      await redis.del(testKeys);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  describe('Phase Service Integration', () => {
    it('should fetch phases from API, store in database, and cache them', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      expect(E.isRight(syncResult)).toBe(true);
      if (E.isRight(syncResult)) {
        const phases = syncResult.right as Phases;
        expect(phases.length).toBeGreaterThan(0);

        const firstPhase = phases[0];
        expect(firstPhase).toHaveProperty('id');
        expect(firstPhase).toHaveProperty('name');
        expect(firstPhase).toHaveProperty('startEvent');
        expect(firstPhase).toHaveProperty('stopEvent');
      }

      const dbPhases = await prisma.phase.findMany();
      expect(dbPhases.length).toBeGreaterThan(0);

      const cacheKey = `${CachePrefix.PHASE}::2425`;
      const keyExists = await redis.exists(cacheKey);
      expect(keyExists).toBe(1);
    });

    it('should fetch all phases after syncing', async () => {
      await phaseService.syncPhasesFromApi()();
      const allPhasesResult = await phaseService.getPhases()();

      expect(E.isRight(allPhasesResult)).toBe(true);
      if (E.isRight(allPhasesResult) && allPhasesResult.right) {
        expect(allPhasesResult.right.length).toBeGreaterThan(0);
      }
    });

    it('should get phase by ID after syncing', async () => {
      const syncResult = await phaseService.syncPhasesFromApi()();

      if (E.isRight(syncResult)) {
        const phases = syncResult.right as Phases;
        if (phases.length > 0) {
          const firstPhaseId = phases[0].id;
          const phaseResult = await phaseService.getPhase(firstPhaseId)();

          expect(E.isRight(phaseResult)).toBe(true);
          if (E.isRight(phaseResult) && phaseResult.right) {
            expect(phaseResult.right.id).toEqual(firstPhaseId);
          }
        }
      }
    });
  });

  describe('Phase Workflow Integration', () => {
    it('should execute the sync phases workflow end-to-end', async () => {
      const workflows = phaseWorkflows(phaseService);
      const result = await workflows.syncPhases()();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right.context).toBeDefined();
        expect(result.right.context.workflowId).toBeDefined();
        expect(result.right.duration).toBeGreaterThan(0);
        expect(result.right.result).toBeDefined();
        expect(result.right.result.length).toBeGreaterThan(0);

        const dbPhases = await prisma.phase.findMany();
        expect(dbPhases.length).toEqual(result.right.result.length);
      }
    });
  });
});
