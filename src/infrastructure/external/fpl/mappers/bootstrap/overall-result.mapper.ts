import { validateEventId } from '@app/domain/types/id.types';
import { EventResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/event.schema';
import { RawEventOverallResult } from '@app/shared/types/domain/event-overall-result.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEventResponseToEventOverallResult = (
  raw: EventResponse,
): E.Either<string, RawEventOverallResult> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEventId(raw.id)),
    E.map((data) => {
      return {
        eventId: data.id,
        averageEntryScore: raw.average_entry_score,
        finished: raw.finished,
        highestScoringEntry: raw.highest_scoring_entry ?? 0,
        highestScore: raw.highest_score ?? 0,
        chipPlays: raw.chip_plays,
        mostSelected: raw.most_selected ?? 0,
        mostTransferredIn: raw.most_transferred_in ?? 0,
        mostCaptained: raw.most_captained ?? 0,
        mostViceCaptained: raw.most_vice_captained ?? 0,
        topElement: raw.top_element ?? 0,
        topElementInfo: raw.top_element_info ?? null,
        transfersMade: raw.transfers_made,
      };
    }),
  );
