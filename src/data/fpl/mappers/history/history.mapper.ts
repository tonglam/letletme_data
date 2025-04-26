import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { EntryHistoryInfoResponse } from 'src/data/fpl/schemas/history/info.schema';
import { EntryHistoryInfo } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';

export const mapEntryHistoryResponseToDomain = (
  entryId: EntryId,
  raw: EntryHistoryInfoResponse,
): E.Either<string, EntryHistoryInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      const transformedSeason = raw.season_name.replace(/^(\d{2})(\d{2})\/(\d{2})$/, '$2$3');

      return {
        entryId: entryId as EntryId,
        season: transformedSeason,
        totalPoints: raw.total_points,
        overallRank: raw.rank,
      };
    }),
  );
};
