import { createEvent, Event } from '@app/domain/event/model';
import { EventIDSchema } from '@app/domain/shared/types/id.types';
import { ChipPlaySchema } from '@app/domain/shared/value-objects/chip-play.types';
import { TopElementInfoSchema } from '@app/domain/shared/value-objects/top-element.types';
import { formatZodErrorForDbError } from '@app/infrastructure/persistence/error';
import { DbEvent, DbEventInsert } from '@app/schemas/tables/event.schema';
import { createDBError, DBError, DBErrorCode } from '@app/shared/types/error.types';
import { safeParseJson } from '@app/shared/utils/common.util';
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

  const chipPlaysResult = safeParseJson(z.array(ChipPlaySchema))(dbEvent.chipPlays);
  if (E.isLeft(chipPlaysResult)) {
    const parseError = chipPlaysResult.left;
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: `Failed to parse chipPlays JSON from DB: ${parseError.message}`,
        cause: parseError,
      }),
    );
  }
  const parsedChipPlays = chipPlaysResult.right;

  const topElementInfoResult = safeParseJson(TopElementInfoSchema.nullable())(
    dbEvent.topElementInfo,
  );
  if (E.isLeft(topElementInfoResult)) {
    const parseError = topElementInfoResult.left;
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: `Failed to parse topElementInfo JSON from DB: ${parseError.message}`,
        cause: parseError,
      }),
    );
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
    chipPlays: parsedChipPlays as z.infer<typeof ChipPlaySchema>[],
    mostSelected: dbEvent.mostSelected,
    mostTransferredIn: dbEvent.mostTransferredIn,
    mostCaptained: dbEvent.mostCaptained,
    mostViceCaptained: dbEvent.mostViceCaptained,
    topElement: dbEvent.topElement,
    topElementInfo: parsedTopElementInfo as z.infer<typeof TopElementInfoSchema> | null,
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
