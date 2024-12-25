import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import {
  createTeamCache,
  createTeamOperations,
  type TeamCacheOperations,
} from '../../domains/teams/cache/cache';
import { getCacheModule } from '../../infrastructure/cache/cache.module';
import { CacheError } from '../../infrastructure/cache/types';
import { Team } from '../../types/teams.type';

export const initializeTeamCache = (bootstrapApi: BootstrapApi): TeamCacheOperations | undefined =>
  pipe(
    getCacheModule().getRedisClient(),
    E.chain((client) =>
      pipe(
        E.tryCatch(
          () => createTeamCache(client),
          (error): CacheError => ({
            type: 'OPERATION_ERROR',
            message: 'Failed to create team cache',
            cause: error,
          }),
        ),
        E.map((teamCache) =>
          createTeamOperations(teamCache, {
            getAll: async () => {
              const data = await bootstrapApi.getBootstrapData();
              return (
                (data?.teams as Team[])?.map((t) => ({
                  ...t,
                  createdAt: new Date(),
                })) ?? []
              );
            },
            getOne: async (id) => {
              const data = await bootstrapApi.getBootstrapData();
              const team = (data?.teams as Team[])?.find((t) => t.id === Number(id));
              return team ? { ...team, createdAt: new Date() } : null;
            },
          }),
        ),
      ),
    ),
    E.getOrElseW(() => undefined),
  );
