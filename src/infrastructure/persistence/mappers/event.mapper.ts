import { createEvent, Event } from '@app/domain/event/model';
import { EventIDSchema } from '@app/domain/shared/types/id.types';
import { ChipPlaySchema } from '@app/domain/shared/value-objects/chip-play.types';
import { TopElementInfoSchema } from '@app/domain/shared/value-objects/top-element.types';
import { formatZodErrorForDbError } from '@app/infrastructure/persistence/utils/error.util';
import { parseDbJsonField } from '@app/infrastructure/persistence/utils/json.util';
import { DbEvent, DbEventInsert } from '@app/schemas/tables/event.schema';
import { createDBError, DBError, DBErrorCode } from '@app/types/error.types';
import * as E from 'fp-ts/Either';
import { z } from 'zod';

export const toDomain = (dbEvent: DbEvent): E.Either<DBError, Event> => {
  const idResult = EventIDSchema.safeParse(dbEvent.id);
  if (!idResult.success) {
    return E.left(formatZodErrorForDbError('Event ID')(idResult.error));
  }
  const validatedId = idResult.data;

  if (!(dbEvent.deadlineTime instanceof Date)) {
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: 'Invalid deadlineTime format from DB',
      }),
    );
  }
  const validatedDeadline = dbEvent.deadlineTime;

  if (typeof dbEvent.chipPlays !== 'string') {
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: `Expected chipPlays to be a string from DB, but received ${typeof dbEvent.chipPlays}`,
      }),
    );
  }
  const chipPlaysResult = parseDbJsonField(z.array(ChipPlaySchema), dbEvent.chipPlays, 'chipPlays');
  if (E.isLeft(chipPlaysResult)) {
    return chipPlaysResult;
  }
  const parsedChipPlays = chipPlaysResult.right;

  if (
    dbEvent.topElementInfo !== null &&
    dbEvent.topElementInfo !== undefined &&
    typeof dbEvent.topElementInfo !== 'string'
  ) {
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: `Expected topElementInfo to be a string, null, or undefined from DB, but received ${typeof dbEvent.topElementInfo}`,
      }),
    );
  }
  const topElementInfoResult = parseDbJsonField(
    TopElementInfoSchema.nullable(),
    dbEvent.topElementInfo,
    'topElementInfo',
  );
  if (E.isLeft(topElementInfoResult)) {
    return topElementInfoResult;
  }
  const parsedTopElementInfo = topElementInfoResult.right;

  const validatedEventData: Event = {
    id: validatedId,
    name: dbEvent.name,
    deadlineTime: validatedDeadline,
    averageEntryScore: dbEvent.averageEntryScore,
    finished: dbEvent.finished,
    dataChecked: dbEvent.dataChecked,
    highestScore: dbEvent.highestScore,
    highestScoringEntry: dbEvent.highestScoringEntry,
    isPrevious: dbEvent.isPrevious,
    isCurrent: dbEvent.isCurrent,
    isNext: dbEvent.isNext,
    cupLeaguesCreated: dbEvent.cupLeaguesCreated,
    h2hKoMatchesCreated: dbEvent.h2hKoMatchesCreated,
    rankedCount: dbEvent.rankedCount,
    chipPlays: parsedChipPlays,
    mostSelected: dbEvent.mostSelected,
    mostTransferredIn: dbEvent.mostTransferredIn,
    mostCaptained: dbEvent.mostCaptained,
    mostViceCaptained: dbEvent.mostViceCaptained,
    topElement: dbEvent.topElement,
    topElementInfo: parsedTopElementInfo,
    transfersMade: dbEvent.transfersMade,
  };

  const domainResult = createEvent(validatedEventData);

  return E.mapLeft((domainError: Error) =>
    createDBError({
      code: DBErrorCode.TRANSFORMATION_ERROR,
      message: `Domain creation failed after mapping: ${domainError.message}`,
      cause: domainError,
    }),
  )(domainResult);
};

export const toPersistence = (event: Event): DbEventInsert => ({
  id: event.id,
  name: event.name,
  deadlineTime: new Date(event.deadlineTime),
  averageEntryScore: event.averageEntryScore,
  finished: event.finished,
  isPrevious: event.isPrevious,
  isCurrent: event.isCurrent,
  isNext: event.isNext,
  dataChecked: event.dataChecked,
  highestScore: event.highestScore === null ? undefined : event.highestScore,
  highestScoringEntry: event.highestScoringEntry === null ? undefined : event.highestScoringEntry,
  cupLeaguesCreated: event.cupLeaguesCreated,
  h2hKoMatchesCreated: event.h2hKoMatchesCreated,
  transfersMade: event.transfersMade,
  rankedCount: event.rankedCount,
  chipPlays: JSON.stringify(event.chipPlays),
  mostSelected: event.mostSelected,
  mostTransferredIn: event.mostTransferredIn,
  mostCaptained: event.mostCaptained,
  mostViceCaptained: event.mostViceCaptained,
  topElement: event.topElement,
  topElementInfo: JSON.stringify(event.topElementInfo),
});
