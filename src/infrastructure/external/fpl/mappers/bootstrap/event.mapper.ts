import { Event } from '@app/domain/models/event.type';
import { EventID, validateEventId } from '@app/domain/types/id.types';
import { EventResponse } from '@app/infrastructure/external/fpl/schemas/bootstrap/event.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEventResponseToEvent = (raw: EventResponse): E.Either<string, Event> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEventId(raw.id)),
    E.map((data) => {
      return {
        id: data.id as EventID,
        name: raw.name,
        deadlineTime: raw.deadline_time,
        averageEntryScore: raw.average_entry_score,
        finished: raw.finished,
        dataChecked: raw.data_checked,
        highestScore: raw.highest_score ?? 0,
        highestScoringEntry: raw.highest_scoring_entry ?? 0,
        isPrevious: raw.is_previous,
        isCurrent: raw.is_current,
        isNext: raw.is_next,
        cupLeaguesCreated: raw.cup_leagues_created,
        h2hKoMatchesCreated: raw.h2h_ko_matches_created,
        rankedCount: raw.ranked_count,
        chipPlays: raw.chip_plays,
        mostSelected: raw.most_selected ?? null,
        mostTransferredIn: raw.most_transferred_in ?? null,
        mostCaptained: raw.most_captained ?? null,
        mostViceCaptained: raw.most_vice_captained ?? null,
        topElement: raw.top_element ?? null,
        topElementInfo: raw.top_element_info ?? null,
        transfersMade: raw.transfers_made,
      };
    }),
  );
