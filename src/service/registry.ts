import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ExtendedBootstrapApi } from '../domain/bootstrap/types';
import { EventOperations, EventRepository } from '../domain/event/types';
import { PhaseRepository } from '../domain/phase/types';
import { PlayerStatRepository } from '../domain/player-stat/types';
import { PlayerValueRepository } from '../domain/player-value/types';
import { APIError, APIErrorCode, createAPIError } from '../types/error.type';
import { PlayerRepository } from '../types/player.type';
import { TeamRepository } from '../types/team.type';
import { ServiceContainer, ServiceKey } from './index';
import { TeamService } from './team';

export interface ServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
  readonly eventRepository: EventRepository;
  readonly eventOperations: EventOperations;
  readonly phaseRepository: PhaseRepository;
  readonly playerRepository: PlayerRepository;
  readonly playerStatRepository: PlayerStatRepository;
  readonly playerValueRepository: PlayerValueRepository;
  readonly teamRepository: TeamRepository;
  readonly teamService: TeamService;
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

const createRegistry = (): Registry => {
  const services = new Map<(typeof ServiceKey)[keyof typeof ServiceKey], ServiceFactory<unknown>>();

  return {
    register: (key, factory) => {
      services.set(key, factory);
      return registry;
    },

    createAll: (deps: ServiceDependencies) =>
      pipe(
        TE.tryCatch(
          async () => {
            const container = {} as ServiceContainer;
            const missingDeps = new Set<string>();

            for (const [key, factory] of services.entries()) {
              // Verify all dependencies are available
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

              // Type-safe assignment to container
              switch (key) {
                case ServiceKey.EVENT:
                case ServiceKey.PHASE:
                case ServiceKey.PLAYER:
                case ServiceKey.PLAYER_STAT:
                case ServiceKey.PLAYER_VALUE:
                case ServiceKey.TEAM:
                  (container as Record<(typeof ServiceKey)[keyof typeof ServiceKey], unknown>)[
                    key
                  ] = result.right;
                  break;
                default:
                  throw new Error(`Unknown service key: ${key}`);
              }
            }

            return container;
          },
          (error) =>
            createAPIError({
              code: APIErrorCode.INTERNAL_SERVER_ERROR,
              message: error instanceof Error ? error.message : 'Failed to initialize services',
            }),
        ),
      ),
  };
};

export const registry = createRegistry();
