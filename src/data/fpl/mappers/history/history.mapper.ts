import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { EntryHistoryInfoResponse } from 'src/data/fpl/schemas/history/info.schema';
import { MappedEntryHistoryInfo } from 'src/types/domain/entry-history-info.type';

export const mapEntryHistoryResponseToDomain = (
  entry: number,
  raw: EntryHistoryInfoResponse,
): E.Either<string, MappedEntryHistoryInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      const transformedSeason = raw.season_name.replace(/^(\d{2})(\d{2})\/(\d{2})$/, '$2$3');

      return {
        entry: entry,
        season: transformedSeason,
        totalPoints: raw.total_points,
        overallRank: raw.rank,
      };
    }),
  );
};
