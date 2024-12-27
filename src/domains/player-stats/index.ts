import { redis } from '@infrastructure/cache/redis';
import { prisma } from '@infrastructure/db/prisma';
import { createPlayerStatsCache } from './cache';
import { createPlayerStatsInvalidation } from './cache/invalidation';
import { createPlayerStatsOperations } from './operations';
import { createPlayerStatsRepository } from './repository';

// Create dependencies
const repository = createPlayerStatsRepository(prisma);
const cache = createPlayerStatsCache(redis);
const cacheInvalidation = createPlayerStatsInvalidation(cache);
const operations = createPlayerStatsOperations(repository, cache, cacheInvalidation);

// Export components
export {
  cache as playerStatsCache,
  operations as playerStatsOperations,
  repository as playerStatsRepository,
};

// Export types
export type { PlayerStatsCache } from './cache';
export type { PlayerStatsInvalidation } from './cache/invalidation';
export type { PlayerStatsOperations } from './operations';
export type { PlayerStatsRepository } from './repository';
