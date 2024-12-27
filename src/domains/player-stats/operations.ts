import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  PlayerStat as DomainPlayerStat,
  PlayerStatId,
  toDomainPlayerStat,
  toPrismaPlayerStat,
} from '../../types/player-stats.type';
import type { PlayerStatCacheOperations } from './cache';
import { playerStatRepository } from './repository';

// We don't use domain operations here since we need to handle the type conversion manually
// due to the difference between create and read types
export const savePlayerStat = (stat: DomainPlayerStat): TE.TaskEither<APIError, DomainPlayerStat> =>
  pipe(
    playerStatRepository.save(toPrismaPlayerStat(stat)),
    TE.map(toDomainPlayerStat),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save player stat' })),
    ),
  );

export const cachePlayerStat =
  (cache: PlayerStatCacheOperations) =>
  (stat: DomainPlayerStat): TE.TaskEither<APIError, void> =>
    pipe(
      cache.setPlayerStats(stat.elementId, stat.eventId, [stat]),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache player stat', details: { error } }),
      ),
    );

export const findAllPlayerStats = (): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    playerStatRepository.findAll(),
    TE.map((stats) => stats.map(toDomainPlayerStat)),
  );

export const findPlayerStatById = (
  id: PlayerStatId,
): TE.TaskEither<APIError, DomainPlayerStat | null> =>
  pipe(
    playerStatRepository.findById(id),
    TE.map((stat) => (stat ? toDomainPlayerStat(stat) : null)),
  );

export const saveBatchPlayerStats = (
  stats: readonly DomainPlayerStat[],
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    stats,
    TE.of,
    TE.map((domainStats) => domainStats.map(toPrismaPlayerStat)),
    TE.chain((prismaStats) =>
      pipe(
        playerStatRepository.saveBatch(prismaStats),
        TE.map((stats) => stats.map(toDomainPlayerStat)),
      ),
    ),
  );

export const findPlayerStatsByElementId = (
  elementId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    playerStatRepository.findByElementId(elementId),
    TE.map((stats) => stats.map(toDomainPlayerStat)),
  );

export const findPlayerStatsByEventId = (
  eventId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    playerStatRepository.findByEventId(eventId),
    TE.map((stats) => stats.map(toDomainPlayerStat)),
  );

export const findPlayerStatByElementAndEvent = (
  elementId: number,
  eventId: number,
): TE.TaskEither<APIError, DomainPlayerStat | null> =>
  pipe(
    playerStatRepository.findByElementAndEvent(elementId, eventId),
    TE.map((stat) => (stat ? toDomainPlayerStat(stat) : null)),
  );

export const findPlayerStatsByTeamId = (
  teamId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    playerStatRepository.findByTeamId(teamId),
    TE.map((stats) => stats.map(toDomainPlayerStat)),
  );
