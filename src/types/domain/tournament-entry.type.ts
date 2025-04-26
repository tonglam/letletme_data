import { EntryId } from 'src/types/domain/entry-info.type';
import { LeagueId } from 'src/types/domain/league.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export type TournamentEntry = {
  readonly tournamentId: TournamentId;
  readonly leagueId: LeagueId;
  readonly entryId: EntryId;
};

export type TournamentEntries = readonly TournamentEntry[];
