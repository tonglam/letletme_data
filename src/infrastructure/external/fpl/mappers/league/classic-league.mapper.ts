import { ClassicLeague } from '@app/domain/models/league.model';
import { EntryID, LeagueID } from '@app/domain/shared/types/id.types';
import { LeagueTypes } from '@app/domain/shared/types/type.types';
import { ClassicLeagueResponse } from '@app/infrastructure/external/fpl/schemas/league/classic-league.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapClassicLeagueResponseToDomain = (
  leagueId: LeagueID,
  raw: ClassicLeagueResponse,
): E.Either<string, ClassicLeague> => {
  return pipe(
    E.Do,
    E.map(() => ({
      id: leagueId as LeagueID,
      name: raw.league.name,
      leagueType: LeagueTypes[0],
      created: new Date(raw.league.created),
      closed: raw.league.closed,
      adminEntryId: raw.league.admin_entry,
      startEventId: raw.league.start_event,
      hasCup: raw.league.has_cup === 'true',
      cupLeague: raw.league.cup_league,
      lastUpdatedData: new Date(raw.last_updated_data),
      standings: raw.standings.results.map((result) => ({
        entryId: result.entry as EntryID,
        entryName: result.entry_name,
        playerName: result.player_name,
        rank: result.rank,
        lastRank: result.last_rank,
        rankSort: result.rank_sort,
        eventPoints: result.event_total,
        totalPoints: result.total,
        hasPlayed: result.has_played,
      })),
    })),
  );
};
