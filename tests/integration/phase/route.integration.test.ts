import { PrismaClient } from '@prisma/client';
import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { PhaseRepository } from 'src/repositories/phase/type';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Setup

// Specific imports
import { phaseRouter } from '../../../src/api/phase/route'; // Import the router
import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createPhaseCache } from '../../../src/domains/phase/cache';
import { PhaseCache } from '../../../src/domains/phase/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createPhaseRepository } from '../../../src/repositories/phase/repository';
import { createPhaseService } from '../../../src/services/phase/service';
import { PhaseService } from '../../../src/services/phase/types';
import { Phase, PhaseId } from '../../../src/types/domain/phase.type';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('Phase Routes Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let app: Express;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let phaseRepository: PhaseRepository;
  let phaseCache: PhaseCache;
  let fplDataService: FplBootstrapDataService;
  let phaseService: PhaseService;

  const cachePrefix = CachePrefix.PHASE;
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

    phaseRepository = createPhaseRepository(prisma);
    phaseCache = createPhaseCache(phaseRepository, {
      keyPrefix: cachePrefix,
      season: testSeason,
    });
    fplDataService = createFplBootstrapDataService(httpClient, logger);
    phaseService = createPhaseService(fplDataService, phaseRepository, phaseCache);

    // Create Express app and mount only the phase router
    app = express();
    app.use(express.json());
    app.use('/phases', phaseRouter(phaseService)); // Mount router
  });

  beforeEach(async () => {
    await prisma.phase.deleteMany({});
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    // Ensure data exists for GET requests by syncing
    await phaseService.syncPhasesFromApi()();
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
  });

  // --- Test Cases ---

  it('GET /phases should return all phases within a data object', async () => {
    const res = await request(app).get('/phases');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    const phases = res.body.data as Phase[];
    expect(phases.length).toBeGreaterThan(0);
    expect(phases[0]).toHaveProperty('id');
    expect(phases[0]).toHaveProperty('name');
  });

  it('GET /phases/:id should return the phase within a data object', async () => {
    const allPhasesResult = await phaseService.getPhases()();
    let targetPhaseId: PhaseId | null = null;
    if (E.isRight(allPhasesResult) && allPhasesResult.right && allPhasesResult.right.length > 0) {
      targetPhaseId = allPhasesResult.right[0].id;
    } else {
      throw new Error('Could not retrieve phases to get an ID for testing');
    }

    const res = await request(app).get(`/phases/${targetPhaseId}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(res.body).toHaveProperty('data');
    expect(res.body.data.id).toBe(targetPhaseId);
    expect(res.body.data).toHaveProperty('name');
  });

  it('GET /phases/:id should return 404 if phase ID does not exist', async () => {
    const nonExistentPhaseId = 9999 as PhaseId;
    const res = await request(app).get(`/phases/${nonExistentPhaseId}`);

    expect(res.status).toBe(404);
  });

  it('POST /phases/sync should trigger synchronization and return success', async () => {
    // Clear cache and DB before testing sync specifically
    await prisma.phase.deleteMany({});
    const keys = await redisClient.keys(`${cachePrefix}::${testSeason}*`);
    if (keys.length > 0) {
      await redisClient.del(keys);
    }

    const res = await request(app).post('/phases/sync');

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // The handler returns void on success, resulting in an empty body

    // Verify data was actually synced
    const phasesInDb = await prisma.phase.findMany();
    expect(phasesInDb.length).toBeGreaterThan(0);
  });
});
