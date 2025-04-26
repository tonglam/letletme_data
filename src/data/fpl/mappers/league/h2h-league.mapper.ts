import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { H2hLeagueResponse } from 'src/data/fpl/schemas/league/h2h-league.schema';
import { LeagueType } from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { H2hLeague, LeagueId } from 'src/types/domain/league.type';

export const mapH2hLeagueResponseToDomain = (
  leagueId: LeagueId,
  raw: H2hLeagueResponse,
): E.Either<string, H2hLeague> => {
  return pipe(
    E.Do,
    E.map(() => ({
      id: leagueId as LeagueId,
      name: raw.league.name,
      leagueType: LeagueType.H2h,
      created: new Date(raw.league.created),
      closed: raw.league.closed,
      adminEntryId: raw.league.admin_entry,
      startEventId: raw.league.start_event,
      hasCup: raw.league.has_cup === 'true',
      cupLeague: raw.league.cup_league,
      koRounds: raw.league.ko_rounds ?? 0,
      lastUpdatedData: new Date(raw.last_updated_data),
      standings: raw.standings.results.map((result) => ({
        entryId: result.entry as EntryId,
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
