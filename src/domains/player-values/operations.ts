import { ValueChangeType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  PlayerValue as DomainPlayerValue,
  PlayerValueId,
  toDomainPlayerValue,
  toPrismaPlayerValue,
} from '../../types/player-values.type';
import type { PlayerValueCacheOperations } from './cache';
import { playerValueRepository } from './repository';

// We don't use domain operations here since we need to handle the type conversion manually
// due to the difference between create and read types
export const savePlayerValue = (
  value: DomainPlayerValue,
): TE.TaskEither<APIError, DomainPlayerValue> =>
  pipe(
    playerValueRepository.save(toPrismaPlayerValue(value)),
    TE.map(toDomainPlayerValue),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save player value' })),
    ),
  );

export const cachePlayerValue =
  (cache: PlayerValueCacheOperations) =>
  (value: DomainPlayerValue): TE.TaskEither<APIError, void> =>
    pipe(
      cache.setPlayerValues(value.elementId, value.eventId, [value]),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache player value', details: { error } }),
      ),
    );

export const findAllPlayerValues = (): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    playerValueRepository.findAll(),
    TE.map((values) => values.map(toDomainPlayerValue)),
  );

export const findPlayerValueById = (
  id: PlayerValueId,
): TE.TaskEither<APIError, DomainPlayerValue | null> =>
  pipe(
    playerValueRepository.findById(id),
    TE.map((value) => (value ? toDomainPlayerValue(value) : null)),
  );

export const saveBatchPlayerValues = (
  values: readonly DomainPlayerValue[],
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    values,
    TE.of,
    TE.map((domainValues) => domainValues.map(toPrismaPlayerValue)),
    TE.chain((prismaValues) =>
      pipe(
        playerValueRepository.saveBatch(prismaValues),
        TE.map((values) => values.map(toDomainPlayerValue)),
      ),
    ),
  );

export const findPlayerValuesByChangeDate = (
  changeDate: string,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    playerValueRepository.findByChangeDate(changeDate),
    TE.map((values) => values.map(toDomainPlayerValue)),
  );

export const findPlayerValuesByElementType = (
  elementType: number,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    playerValueRepository.findByElementType(elementType),
    TE.map((values) => values.map(toDomainPlayerValue)),
  );

export const findPlayerValuesByChangeType = (
  changeType: ValueChangeType,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    playerValueRepository.findByChangeType(changeType),
    TE.map((values) => values.map(toDomainPlayerValue)),
  );

export const findPlayerValuesByEventId = (
  eventId: number,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    playerValueRepository.findByEventId(eventId),
    TE.map((values) => values.map(toDomainPlayerValue)),
  );
