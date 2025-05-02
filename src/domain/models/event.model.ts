import { EventID, validateEventId } from '@app/domain/types/id.types';
import { ChipPlay } from '@app/domain/value-objects/chip-play.types';
import { TopElementInfo } from '@app/domain/value-objects/top-element.types';
import { DbEvent } from '@app/infrastructure/persistence/drizzle/schemas/tables/event.schema';
import { safeParseJson } from '@app/shared/utils/common.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

// --- model ---
export interface Event {
  readonly id: EventID;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly finished: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly averageEntryScore: number;
  readonly dataChecked: boolean;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly transfersMade: number;
  readonly rankedCount: number;
  readonly chipPlays: ChipPlay[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
}

// --- create ---
export const createEvent = (input: DbEvent): E.Either<Error, Event> => {
  return pipe(
    validateEventId(input.id),
    E.chain((validatedId) =>
      pipe(
        validateDeadline(input.deadlineTime),
        E.map((validatedDeadline) => ({ validatedId, validatedDeadline })),
      ),
    ),
    E.chain(({ validatedId, validatedDeadline }) =>
      pipe(
        safeParseJson(ChipPlay.array())(input.chipPlays),
        E.map((parsedChipPlays) => ({ validatedId, validatedDeadline, parsedChipPlays })),
      ),
    ),
    E.chain(({ validatedId, validatedDeadline, parsedChipPlays }) =>
      pipe(
        safeParseJson(TopElementInfo.nullable())(input.topElementInfo),
        E.map((parsedTopElementInfo) => ({
          validatedId,
          validatedDeadline,
          parsedChipPlays,
          parsedTopElementInfo,
        })),
      ),
    ),
    E.map(({ validatedId, validatedDeadline, parsedChipPlays, parsedTopElementInfo }) => ({
      id: validatedId,
      name: input.name,
      deadlineTime: validatedDeadline,
      averageEntryScore: input.averageEntryScore,
      finished: input.finished,
      dataChecked: input.dataChecked,
      highestScore: input.highestScore,
      highestScoringEntry: input.highestScoringEntry,
      isPrevious: input.isPrevious,
      isCurrent: input.isCurrent,
      isNext: input.isNext,
      cupLeaguesCreated: input.cupLeaguesCreated,
      h2hKoMatchesCreated: input.h2hKoMatchesCreated,
      rankedCount: input.rankedCount,
      chipPlays: parsedChipPlays,
      mostSelected: input.mostSelected,
      mostTransferredIn: input.mostTransferredIn,
      mostCaptained: input.mostCaptained,
      mostViceCaptained: input.mostViceCaptained,
      topElement: input.topElement,
      topElementInfo: parsedTopElementInfo,
      transfersMade: input.transfersMade,
    })),
  );
};

// --- validate ---
const validateDeadline = (date: Date): E.Either<Error, Date> =>
  date > new Date() ? E.right(date) : E.left(new Error('Deadline must be in the future'));
