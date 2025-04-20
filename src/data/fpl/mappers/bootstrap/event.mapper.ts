import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { ChipPlay, Event, TopElementInfo, validateEventId } from 'src/types/domain/event.type';

import { EventResponse } from '../../schemas/bootstrap/event.schema';

const transformChipPlays = (
  apiChipPlays: readonly { chip_name: string; num_played: number }[] | undefined | null,
): readonly ChipPlay[] => {
  if (!apiChipPlays) return [];
  return apiChipPlays;
};

const transformTopElementInfo = (
  apiInfo: { id: number; points: number } | undefined | null,
): TopElementInfo | null => {
  if (!apiInfo) return null;
  return apiInfo;
};

export const mapEventResponseToEvent = (raw: EventResponse): E.Either<string, Event> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEventId(raw.id)),
    E.map((data) => {
      const chipPlays = transformChipPlays(raw.chip_plays);
      const topElementInfo = transformTopElementInfo(raw.top_element_info);

      return {
        id: data.id,
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
        chipPlays: chipPlays,
        mostSelected: raw.most_selected ?? null,
        mostTransferredIn: raw.most_transferred_in ?? null,
        mostCaptained: raw.most_captained ?? null,
        mostViceCaptained: raw.most_vice_captained ?? null,
        topElement: raw.top_element ?? null,
        topElementInfo: topElementInfo,
        transfersMade: raw.transfers_made,
      };
    }),
  );
