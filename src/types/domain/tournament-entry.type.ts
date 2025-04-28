import { EntryId } from 'types/domain/entry-info.type';
import { LeagueId } from 'types/domain/league.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export type TournamentEntry = {
  readonly tournamentId: TournamentId;
  readonly leagueId: LeagueId;
  readonly entryId: EntryId;
};

export type TournamentEntries = readonly TournamentEntry[];
