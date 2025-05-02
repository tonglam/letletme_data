import { EntryID, LeagueID } from '@app/domain/types/id.types';
import { LeagueTypes } from '@app/domain/types/type.types';
import { H2hLeagueResponse } from '@app/infrastructure/external/fpl/schemas/league/h2h-league.schema';
import { H2hLeague } from '@app/shared/types/domain/league.type';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapH2hLeagueResponseToDomain = (
  leagueId: LeagueID,
  raw: H2hLeagueResponse,
): E.Either<string, H2hLeague> => {
  return pipe(
    E.Do,
    E.map(() => ({
      id: leagueId as LeagueID,
      name: raw.league.name,
      leagueType: LeagueTypes[1],
      created: new Date(raw.league.created),
      closed: raw.league.closed,
      adminEntryId: raw.league.admin_entry,
      startEventId: raw.league.start_event,
      hasCup: raw.league.has_cup === 'true',
      cupLeague: raw.league.cup_league,
      koRounds: raw.league.ko_rounds ?? 0,
      lastUpdatedData: new Date(raw.last_updated_data),
      standings: raw.standings.results.map((result) => ({
        entryId: result.entry as EntryID,
        entryName: result.entry_name,
        playerName: result.player_name,
        rank: result.rank,
        lastRank: result.last_rank,
        rankSort: result.rank_sort,
        eventPoints: result.total,
        totalPoints: result.points_for,
        played: result.matches_played,
        won: result.matches_won,
        drawn: result.matches_drawn,
        lost: result.matches_lost,
      })),
    })),
  );
};
