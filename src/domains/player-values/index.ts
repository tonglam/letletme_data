import { redis } from '@infrastructure/cache/redis';
import { prisma } from '@infrastructure/db/prisma';
import { createPlayerValuesCache } from './cache';
import { createPlayerValuesInvalidation } from './cache/invalidation';
import { createPlayerValuesOperations } from './operations';
import { createPlayerValuesRepository } from './repository';

// Create dependencies
const repository = createPlayerValuesRepository(prisma);
const cache = createPlayerValuesCache(redis);
const cacheInvalidation = createPlayerValuesInvalidation(cache);
const operations = createPlayerValuesOperations(repository, cache, cacheInvalidation);

// Export components
export {
  cache as playerValuesCache,
  operations as playerValuesOperations,
  repository as playerValuesRepository,
};

// Export types
export type { PlayerValuesCache } from './cache';
export type { PlayerValuesInvalidation } from './cache/invalidation';
export type { PlayerValuesOperations } from './operations';
export type { PlayerValuesRepository } from './repository';
