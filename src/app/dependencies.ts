import axios, { AxiosInstance } from 'axios';
import { PlayerCache, PlayerRepository } from 'domains/player/types';
import { createPlayerStatCache } from 'domains/player-stat/cache';
import { PlayerStatCache, PlayerStatRepository } from 'domains/player-stat/types';
import { createPlayerValueCache } from 'domains/player-value/cache';
import { PlayerValueCache, PlayerValueRepository } from 'domains/player-value/types';
import { TeamCache, TeamRepository } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';

import { createFplBootstrapDataService } from '../data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../data/types';
import { createEventCache } from '../domains/event/cache';
import { EventCache, EventRepository } from '../domains/event/types';
import { createPhaseCache } from '../domains/phase/cache';
import { PhaseCache, PhaseRepository } from '../domains/phase/types';
import { createPlayerCache } from '../domains/player/cache';
import { createTeamCache } from '../domains/team/cache';
import { prisma } from '../infrastructures/db/prisma';
import { createHTTPClient, HTTPClient, HTTPClientContext } from '../infrastructures/http/index';
import { RetryConfig } from '../infrastructures/http/types';
import { getFplApiLogger } from '../infrastructures/logger';
import { createEventRepository } from '../repositories/event/repository';
import { createPhaseRepository } from '../repositories/phase/repository';
import { createPlayerRepository } from '../repositories/player/repository';
import { createPlayerStatRepository } from '../repositories/player-stat/repository';
import { createPlayerValueRepository } from '../repositories/player-value/repository';
import { createTeamRepository } from '../repositories/team/repository';
import { APIError } from '../types/error.type';

export interface ServiceDependencies {
  readonly fplDataService: FplBootstrapDataService;
  readonly eventRepository: EventRepository;
  readonly phaseRepository: PhaseRepository;
  readonly teamRepository: TeamRepository;
  readonly playerRepository: PlayerRepository;
  readonly playerStatRepository: PlayerStatRepository;
  readonly playerValueRepository: PlayerValueRepository;

  readonly eventCache: EventCache;
  readonly phaseCache: PhaseCache;
  readonly teamCache: TeamCache;
  readonly playerCache: PlayerCache;
  readonly playerStatCache: PlayerStatCache;
  readonly playerValueCache: PlayerValueCache;
}

export const createDependencies = (): TE.TaskEither<APIError, ServiceDependencies> => {
  return pipe(
    TE.Do,
    TE.bind('logger', () => TE.right<APIError, Logger>(getFplApiLogger())),
    TE.bind('httpClientContext', ({ logger }) => {
      const defaultRetryConfig: RetryConfig = {
        attempts: 3,
        baseDelay: 100,
        maxDelay: 1000,
        shouldRetry: (error: APIError): boolean => {
          const status = error.details?.httpStatus as number | undefined;
          return !!status && status >= 500 && status < 600;
        },
      };
      const axiosInstance: AxiosInstance = axios.create({
        timeout: 5000,
      });
      const context: HTTPClientContext = {
        client: axiosInstance,
        retryConfig: defaultRetryConfig,
        logger: logger,
      };
      return TE.right<APIError, HTTPClientContext>(context);
    }),
    TE.bind('fplClient', ({ httpClientContext }) =>
      TE.right<APIError, HTTPClient>(createHTTPClient(httpClientContext)),
    ),
    TE.map(({ logger, fplClient }) => {
      const eventRepository = createEventRepository(prisma);
      const phaseRepository = createPhaseRepository(prisma);
      const teamRepository = createTeamRepository(prisma);
      const playerRepository = createPlayerRepository(prisma);
      const playerStatRepository = createPlayerStatRepository(prisma);
      const playerValueRepository = createPlayerValueRepository(prisma);

      const eventCache = createEventCache(eventRepository);
      const phaseCache = createPhaseCache(phaseRepository);
      const teamCache = createTeamCache(teamRepository);
      const playerCache = createPlayerCache(playerRepository);
      const playerStatCache = createPlayerStatCache(playerStatRepository);
      const playerValueCache = createPlayerValueCache(playerValueRepository);

      const fplDataService = createFplBootstrapDataService(fplClient, logger);

      const dependencies: ServiceDependencies = {
        fplDataService,
        eventRepository,
        phaseRepository,
        teamRepository,
        playerRepository,
        playerStatRepository,
        playerValueRepository,

        eventCache,
        phaseCache,
        teamCache,
        playerCache,
        playerStatCache,
        playerValueCache,
      };
      return dependencies;
    }),
  );
};
