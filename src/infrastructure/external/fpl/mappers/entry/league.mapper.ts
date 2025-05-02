import { EntryID, LeagueID } from '@app/domain/types/id.types';
import { LeagueType } from '@app/domain/types/type.types';
import { LeagueInfoResponse } from '@app/infrastructure/external/fpl/schemas/entry/league-info.schema';
import { EntryLeagueInfo } from '@app/shared/types/domain/entry-league-info.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapLeagueInfoResponseToEntryLeague = (
  entryId: EntryID,
  leagueType: LeagueType,
  raw: LeagueInfoResponse,
): E.Either<string, EntryLeagueInfo> => {
  return pipe(
    E.Do,
    E.map(() => {
      return {
        entryId: entryId as EntryID,
        leagueId: raw.id as LeagueID,
        leagueName: raw.name,
        leagueType: leagueType,
        startedEvent: raw.start_event,
        entryRank: raw.entry_rank,
        entryLastRank: raw.entry_last_rank,
      };
    }),
  );
};
