import { EntryID } from '@app/domain/types/id.types';
import { EntryHistoryInfoResponse } from '@app/infrastructure/external/fpl/schemas/history/info.schema';
import { EntryHistoryInfo } from '@app/shared/types/domain/entry-history-info.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEntryHistoryResponseToDomain = (
  entryId: EntryID,
  raw: EntryHistoryInfoResponse,
): E.Either<string, EntryHistoryInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      const transformedSeason = raw.season_name.replace(/^(\d{2})(\d{2})\/(\d{2})$/, '$2$3');

      return {
        entryId: entryId as EntryID,
        season: transformedSeason,
        totalPoints: raw.total_points,
        overallRank: raw.rank,
      };
    }),
  );
};
