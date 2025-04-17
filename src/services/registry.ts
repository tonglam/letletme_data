import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { FplBootstrapDataService } from '../data/types';
import { EventCache, EventRepository } from '../domains/event/types';
import { PhaseCache, PhaseRepository } from '../domains/phase/types';
import { APIError, APIErrorCode, createAPIError } from '../types/error.type';
import { ServiceContainer, ServiceKey } from './types';

export interface ServiceDependencies {
  readonly fplDataService: FplBootstrapDataService;
  readonly eventRepository: EventRepository;
  readonly eventCache: EventCache;
  readonly phaseRepository: PhaseRepository;
  readonly phaseCache: PhaseCache;
}

export interface ServiceFactory<T> {
  readonly create: (deps: ServiceDependencies) => TE.TaskEither<APIError, T>;
  readonly dependencies: ReadonlyArray<keyof ServiceDependencies>;
}

export interface Registry {
  readonly register: <T>(
    key: (typeof ServiceKey)[keyof typeof ServiceKey],
    factory: ServiceFactory<T>,
  ) => Registry;
  readonly createAll: (deps: ServiceDependencies) => TE.TaskEither<APIError, ServiceContainer>;
}

export const createRegistry = (): Registry => {
  const services = new Map<(typeof ServiceKey)[keyof typeof ServiceKey], ServiceFactory<unknown>>();

  const currentRegistry: Registry = {
    register: (key, factory) => {
      services.set(key, factory);
      return currentRegistry;
    },

    createAll: (deps: ServiceDependencies) =>
      pipe(
        TE.tryCatch(
          async () => {
            const serviceMap = new Map<string, unknown>();
            const missingDeps = new Set<string>();

            for (const [key, factory] of services.entries()) {
              factory.dependencies.forEach((dep) => {
                if (!(dep in deps)) {
                  missingDeps.add(dep as string);
                }
              });

              if (missingDeps.size > 0) {
                throw new Error(
                  `Missing dependencies for service ${key}: ${Array.from(missingDeps).join(', ')}`,
                );
              }

              const result = await factory.create(deps)();
              if ('left' in result) {
                throw result.left;
              }

              serviceMap.set(key, result.right);
            }

            return {
              eventService: serviceMap.get(ServiceKey.EVENT),
              phaseService: serviceMap.get(ServiceKey.PHASE),
              playerService: serviceMap.get(ServiceKey.PLAYER),
              playerStatService: serviceMap.get(ServiceKey.PLAYER_STAT),
              playerValueService: serviceMap.get(ServiceKey.PLAYER_VALUE),
              teamService: serviceMap.get(ServiceKey.TEAM),
            } as ServiceContainer;
          },
          (error) =>
            createAPIError({
              code: APIErrorCode.INTERNAL_SERVER_ERROR,
              message: error instanceof Error ? error.message : 'Failed to initialize services',
            }),
        ),
      ),
  };

  return currentRegistry;
};

export const registry = createRegistry();
