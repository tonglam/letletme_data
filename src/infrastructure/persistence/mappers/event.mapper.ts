import { Event } from '@app/domain/models/event.model';
import { ChipPlay } from '@app/domain/value-objects/chip-play.types';
import { TopElementInfo } from '@app/domain/value-objects/top-element.types';
import { DbEvent, DbEventInsert } from '@app/schemas/tables/event.schema';
import { DBError, DBErrorCode, createDBError } from '@app/shared/types/error.types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const fromPersistence = (dbEvent: DbEvent): E.Either<DBError, Event> => {
  return pipe(
    E.Do,
    E.bind('parsedChipPlays', () =>
      pipe(
        E.tryCatch(
          () => {
            const jsonString = typeof dbEvent.chipPlays === 'string' ? dbEvent.chipPlays : '[]';
            return JSON.parse(jsonString);
          },
          (e) =>
            createDBError({
              message: 'Invalid chipPlays JSON format',
              code: DBErrorCode.TRANSFORMATION_ERROR,
              cause: e as Error,
            }),
        ),
        E.chainW((json) =>
          pipe(ChipPlay.array().safeParse(json), (result) =>
            result.success
              ? E.right(result.data)
              : E.left(
                  createDBError({
                    message: 'ChipPlays validation failed',
                    code: DBErrorCode.VALIDATION_ERROR,
                    details: result.error.format(),
                  }),
                ),
          ),
        ),
      ),
    ),
    E.bind('parsedTopElementInfo', () =>
      pipe(
        E.tryCatch(
          () => {
            const jsonString =
              typeof dbEvent.topElementInfo === 'string' ? dbEvent.topElementInfo : 'null';
            return JSON.parse(jsonString);
          },
          (e) =>
            createDBError({
              message: 'Invalid topElementInfo JSON format',
              code: DBErrorCode.TRANSFORMATION_ERROR,
              cause: e as Error,
            }),
        ),
        E.chainW((json) =>
          pipe(TopElementInfo.nullable().safeParse(json), (result) =>
            result.success
              ? E.right(result.data)
              : E.left(
                  createDBError({
                    message: 'TopElementInfo validation failed',
                    code: DBErrorCode.VALIDATION_ERROR,
                    details: result.error.format(),
                  }),
                ),
          ),
        ),
      ),
    ),
    E.map(({ parsedChipPlays, parsedTopElementInfo }) => {
      const eventId = dbEvent.id as Event['id'];

      return {
        id: eventId,
        name: dbEvent.name,
        deadlineTime: dbEvent.deadlineTime,
        averageEntryScore: dbEvent.averageEntryScore,
        finished: dbEvent.finished,
        isPrevious: dbEvent.isPrevious,
        isCurrent: dbEvent.isCurrent,
        isNext: dbEvent.isNext,
        dataChecked: dbEvent.dataChecked,
        highestScore: dbEvent.highestScore,
        highestScoringEntry: dbEvent.highestScoringEntry,
        cupLeaguesCreated: dbEvent.cupLeaguesCreated,
        h2hKoMatchesCreated: dbEvent.h2hKoMatchesCreated,
        transfersMade: dbEvent.transfersMade,
        rankedCount: dbEvent.rankedCount,
        chipPlays: parsedChipPlays,
        mostSelected: dbEvent.mostSelected,
        mostTransferredIn: dbEvent.mostTransferredIn,
        mostCaptained: dbEvent.mostCaptained,
        mostViceCaptained: dbEvent.mostViceCaptained,
        topElement: dbEvent.topElement,
        topElementInfo: parsedTopElementInfo,
      };
    }),
  );
};

export const toPersistence = (event: Event): DbEventInsert => ({
  id: event.id,
  name: event.name,
  deadlineTime: new Date(event.deadlineTime),
  finished: event.finished,
  isPrevious: event.isPrevious,
  isCurrent: event.isCurrent,
  isNext: event.isNext,
  dataChecked: event.dataChecked,
  highestScore: event.highestScore,
  highestScoringEntry: event.highestScoringEntry,
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
