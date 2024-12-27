import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from '../../infrastructure/db/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  PlayerStat as DomainPlayerStat,
  PrismaPlayerStat,
  toDomainPlayerStat,
  toPrismaPlayerStat,
} from '../../types/player-stats.type';
import type { PlayerStatCacheOperations } from './cache';
import { playerStatRepository } from './repository';

const { single, array } = createDomainOperations<DomainPlayerStat, PrismaPlayerStat>({
  toDomain: toDomainPlayerStat,
  toPrisma: toPrismaPlayerStat,
});

export const savePlayerStat = (stat: DomainPlayerStat): TE.TaskEither<APIError, DomainPlayerStat> =>
  pipe(
    playerStatRepository.save(single.fromDomain(stat)),
    TE.map(single.toDomain),
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
  pipe(playerStatRepository.findAll(), TE.map(array.toDomain));

export const findPlayerStatById = (id: string): TE.TaskEither<APIError, DomainPlayerStat | null> =>
  pipe(playerStatRepository.findById(id), TE.map(single.toDomain));

export const saveBatchPlayerStats = (
  stats: readonly DomainPlayerStat[],
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(
    stats,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaStats) =>
      pipe(playerStatRepository.saveBatch(prismaStats), TE.map(array.toDomain)),
    ),
  );

export const findPlayerStatsByElementId = (
  elementId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(playerStatRepository.findByElementId(elementId), TE.map(array.toDomain));

export const findPlayerStatsByEventId = (
  eventId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(playerStatRepository.findByEventId(eventId), TE.map(array.toDomain));

export const findPlayerStatByElementAndEvent = (
  elementId: number,
  eventId: number,
): TE.TaskEither<APIError, DomainPlayerStat | null> =>
  pipe(playerStatRepository.findByElementAndEvent(elementId, eventId), TE.map(single.toDomain));

export const findPlayerStatsByTeamId = (
  teamId: number,
): TE.TaskEither<APIError, readonly DomainPlayerStat[]> =>
  pipe(playerStatRepository.findByTeamId(teamId), TE.map(array.toDomain));
