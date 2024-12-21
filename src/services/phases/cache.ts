import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import {
  createPhaseCache,
  createPhaseOperations,
  type PhaseCacheOperations,
} from '../../domains/phases/cache/cache';
import { getCacheModule } from '../../infrastructure/cache/cache.module';
import { CacheError } from '../../infrastructure/cache/types';

export const initializePhaseCache = (
  bootstrapApi: BootstrapApi,
): PhaseCacheOperations | undefined =>
  pipe(
    getCacheModule().getRedisClient(),
    E.chain((client) =>
      pipe(
        E.tryCatch(
          () => createPhaseCache(client),
          (error): CacheError => ({
            type: 'OPERATION_ERROR',
            message: 'Failed to create phase cache',
            cause: error,
          }),
        ),
        E.map((phaseCache) =>
          createPhaseOperations(phaseCache, {
            getAllPhases: async () => {
              const phases = await bootstrapApi.getBootstrapData();
              return (
                phases?.map((p) => ({
                  ...p,
                  createdAt: new Date(),
                })) ?? []
              );
            },
            getPhase: async (id) => {
              const phases = await bootstrapApi.getBootstrapData();
              const phase = phases?.find((p) => p.id === Number(id));
              return phase ? { ...phase, createdAt: new Date() } : null;
            },
          }),
        ),
      ),
    ),
    E.getOrElseW(() => undefined),
  );
