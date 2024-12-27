import { fplClient } from '@infrastructure/api/fpl';
import { redis } from '@infrastructure/cache/redis';
import { prisma } from '@infrastructure/db/prisma';
import { metaQueue } from '@infrastructure/queue/meta';
import { createPlayerJob, registerPlayerJobs } from '@services/queue/meta/players.job';
import { createPlayerCache } from './cache/cache';
import { createCacheInvalidation } from './cache/invalidation';
import { createPlayerOperations } from './operations';
import { createPlayerRepository } from './repository';
import { playerRouter, registerPlayerRoutes } from './routes';

// Create dependencies
const repository = createPlayerRepository(prisma);
const cache = createPlayerCache(redis);
const cacheInvalidation = createCacheInvalidation(cache);
const operations = createPlayerOperations(repository, cache, cacheInvalidation);
const job = createPlayerJob(metaQueue, operations, fplClient);

// Register jobs and routes
registerPlayerJobs(job, metaQueue);
registerPlayerRoutes(operations, job);

// Export components
export {
  cache as playerCache,
  job as playerJob,
  operations as playerOperations,
  repository as playerRepository,
  playerRouter,
};

// Export types
export type { PlayerJob } from '@services/queue/meta/players.job';
export type { PlayerCache } from './cache/cache';
export type { PlayerOperations } from './operations';
export type { PlayerRepository } from './repository';
