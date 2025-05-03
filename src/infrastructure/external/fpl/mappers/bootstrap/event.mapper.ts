import { Event } from '@app/domain/event/model';
import { EventSchema } from '@app/domain/event/schema';
import { EventResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/event.schema';
import { formatZodError } from '@app/shared/utils/error.util';
import { safeParseResultToEither } from '@app/shared/utils/zod.utils';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEventResponseToEvent = (raw: EventResponse): E.Either<Error, Event> =>
  pipe(
    {
      id: raw.id,
      name: raw.name,
      deadlineTime: raw.deadline_time,
      finished: raw.finished,
      isPrevious: raw.is_previous,
      isCurrent: raw.is_current,
      isNext: raw.is_next,
      averageEntryScore: raw.average_entry_score,
      dataChecked: raw.data_checked,
      highestScore: raw.highest_score,
      highestScoringEntry: raw.highest_scoring_entry,
      cupLeaguesCreated: raw.cup_leagues_created,
      h2hKoMatchesCreated: raw.h2h_ko_matches_created,
      transfersMade: raw.transfers_made,
      rankedCount: raw.ranked_count,
      chipPlays: raw.chip_plays,
      mostSelected: raw.most_selected,
      mostTransferredIn: raw.most_transferred_in,
      mostCaptained: raw.most_captained,
      mostViceCaptained: raw.most_vice_captained,
      topElement: raw.top_element,
      topElementInfo: raw.top_element_info,
    },
    EventSchema.safeParse,
    safeParseResultToEither,
    E.mapLeft((zodError) => formatZodError(zodError, 'FPL EventResponse')),
  );
