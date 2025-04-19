import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { LeagueInfoResponse } from 'src/data/fpl/schemas/entry/league-info.schema';
import { LeagueType } from 'src/types/base.type';
import { MappedEntryLeagueInfo } from 'src/types/domain/entry-league-info.type';

export const mapLeagueInfoResponseToEntryLeague = (
  entry: number,
  leagueType: LeagueType,
  raw: LeagueInfoResponse,
): E.Either<string, MappedEntryLeagueInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      return {
        entry: entry,
        leagueId: raw.id,
        leagueName: raw.name,
        leagueType: leagueType,
        entryRank: raw.entry_rank,
        entryLastRank: raw.entry_last_rank,
        startedEvent: raw.start_event,
      };
    }),
  );
};
