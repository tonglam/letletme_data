import { ValueChangeType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from '../../infrastructure/db/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  PlayerValue as DomainPlayerValue,
  PrismaPlayerValue,
  toDomainPlayerValue,
  toPrismaPlayerValue,
} from '../../types/player-values.type';
import type { PlayerValueCacheOperations } from './cache';
import { playerValueRepository } from './repository';

const { single, array } = createDomainOperations<DomainPlayerValue, PrismaPlayerValue>({
  toDomain: toDomainPlayerValue,
  toPrisma: toPrismaPlayerValue,
});

export const savePlayerValue = (
  value: DomainPlayerValue,
): TE.TaskEither<APIError, DomainPlayerValue> =>
  pipe(
    playerValueRepository.save(single.fromDomain(value)),
    TE.map(single.toDomain),
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
  pipe(playerValueRepository.findAll(), TE.map(array.toDomain));

export const findPlayerValueById = (
  id: string,
): TE.TaskEither<APIError, DomainPlayerValue | null> =>
  pipe(playerValueRepository.findById(id), TE.map(single.toDomain));

export const saveBatchPlayerValues = (
  values: readonly DomainPlayerValue[],
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(
    values,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaValues) =>
      pipe(playerValueRepository.saveBatch(prismaValues), TE.map(array.toDomain)),
    ),
  );

export const findPlayerValuesByChangeDate = (
  changeDate: string,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(playerValueRepository.findByChangeDate(changeDate), TE.map(array.toDomain));

export const findPlayerValuesByElementType = (
  elementType: number,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(playerValueRepository.findByElementType(elementType), TE.map(array.toDomain));

export const findPlayerValuesByChangeType = (
  changeType: ValueChangeType,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(playerValueRepository.findByChangeType(changeType), TE.map(array.toDomain));

export const findPlayerValuesByEventId = (
  eventId: number,
): TE.TaskEither<APIError, readonly DomainPlayerValue[]> =>
  pipe(playerValueRepository.findByEventId(eventId), TE.map(array.toDomain));
