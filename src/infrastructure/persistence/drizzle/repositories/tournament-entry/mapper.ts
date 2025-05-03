import {
  DbTournamentEntry,
  DbTournamentEntryCreateInput,
  TournamentEntryCreateInput,
} from 'repository/tournament-entry/types';
import { EntryId } from 'types/domain/entry-info.type';
import { LeagueId } from 'types/domain/league.type';
import { TournamentEntry } from 'types/domain/tournament-entry.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export const mapDbTournamentEntryToDomain = (
  dbTournamentEntry: DbTournamentEntry,
): TournamentEntry => ({
  tournamentId: dbTournamentEntry.tournamentId as TournamentId,
  leagueId: dbTournamentEntry.leagueId as LeagueId,
  entryId: dbTournamentEntry.entryId as EntryId,
});

export const mapDomainTournamentEntryToDbCreate = (
  domainTournamentEntry: TournamentEntryCreateInput,
): DbTournamentEntryCreateInput => ({
  tournamentId: domainTournamentEntry.tournamentId,
  leagueId: domainTournamentEntry.leagueId,
  entryId: domainTournamentEntry.entryId,
});
