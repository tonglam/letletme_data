import { LeagueInfoResponse } from 'data/fpl/schemas/entry/league-info.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';

export const mapLeagueInfoResponseToEntryLeague = (
  entryId: EntryId,
  leagueType: LeagueType,
  raw: LeagueInfoResponse,
): E.Either<string, EntryLeagueInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      return {
        entryId: entryId as EntryId,
        leagueId: raw.id as LeagueId,
        leagueName: raw.name,
        leagueType: leagueType,
        startedEvent: raw.start_event,
        entryRank: raw.entry_rank,
        entryLastRank: raw.entry_last_rank,
      };
    }),
  );
};
