import { CachePrefix, DefaultTTL } from 'configs/cache/cache.config';
import { PhaseCache, PhaseCacheConfig } from 'domains/phase/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructures/cache/client';
import { Phase, Phases } from 'types/domain/phase.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';
import { mapCacheErrorToDomainError } from 'utils/error.util';

const parsePhase = (phaseStr: string): E.Either<CacheError, Phase> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(phaseStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse phase JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Phase)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid Phase structure',
            }),
          ),
    ),
  );

const parsePhases = (phaseMaps: Record<string, string>): E.Either<CacheError, Phases> =>
  pipe(
    Object.values(phaseMaps),
    (phaseStrs) =>
      phaseStrs.map((str) =>
        pipe(
          parsePhase(str),
          E.getOrElse<CacheError, Phase | null>(() => null),
        ),
      ),
    (parsedPhases) => parsedPhases.filter((phase): phase is Phase => phase !== null),
    (validPhases) => E.right(validPhases),
  );

export const createPhaseCache = (
  config: PhaseCacheConfig = {
    keyPrefix: CachePrefix.PHASE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.PHASE,
  },
): PhaseCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getAllPhases = (): TE.TaskEither<DomainError, Phases> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all phases',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((phasesMap) => Object.keys(phasesMap).length > 0),
          O.fold(
            () => TE.right([] as Phases),
            (cachedPhases): TE.TaskEither<DomainError, Phases> =>
              pipe(
                parsePhases(cachedPhases),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setAllPhases = (phases: Phases): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (phases.length > 0) {
            const items: Record<string, string> = {};
            phases.forEach((phase) => {
              items[phase.id.toString()] = JSON.stringify(phase);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all phases in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getAllPhases,
    setAllPhases,
  };
};
