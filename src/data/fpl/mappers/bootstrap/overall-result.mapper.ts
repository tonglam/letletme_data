import { EventResponse } from 'data/fpl/schemas/bootstrap/event.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { RawEventOverallResult } from 'types/domain/event-overall-result.type';
import { ChipPlay, TopElementInfo, validateEventId } from 'types/domain/event.type';

const transformChipPlays = (
  apiChipPlays: readonly { chip_name: string; num_played: number }[] | undefined | null,
): ChipPlay[] => {
  if (!apiChipPlays) return [];
  return [...apiChipPlays];
};

const transformTopElementInfo = (
  apiInfo: { id: number; points: number } | undefined | null,
): TopElementInfo => {
  if (!apiInfo) return { id: 0, points: 0 };
  return apiInfo;
};

export const mapEventResponseToEventOverallResult = (
  raw: EventResponse,
): E.Either<string, RawEventOverallResult> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEventId(raw.id)),
    E.map((data) => {
      const chipPlays = transformChipPlays(raw.chip_plays);
      const topElementInfo = transformTopElementInfo(raw.top_element_info);

      return {
        eventId: data.id,
        averageEntryScore: raw.average_entry_score,
        finished: raw.finished,
        highestScoringEntry: raw.highest_scoring_entry ?? 0,
        highestScore: raw.highest_score ?? 0,
        chipPlays: chipPlays,
        mostSelected: raw.most_selected ?? 0,
        mostTransferredIn: raw.most_transferred_in ?? 0,
        mostCaptained: raw.most_captained ?? 0,
        mostViceCaptained: raw.most_vice_captained ?? 0,
        topElement: raw.top_element ?? 0,
        topElementInfo: topElementInfo,
        transfersMade: raw.transfers_made,
      };
    }),
  );
