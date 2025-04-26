import {
  PrismaTournamentEntry,
  PrismaTournamentEntryCreateInput,
  TournamentEntryCreateInput,
} from 'src/repositories/tournament-entry/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { LeagueId } from 'src/types/domain/league.type';
import { TournamentEntry } from 'src/types/domain/tournament-entry.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export const mapPrismaTournamentEntryToDomain = (
  prismaTournamentEntry: PrismaTournamentEntry,
): TournamentEntry => ({
  tournamentId: prismaTournamentEntry.tournamentId as TournamentId,
  leagueId: prismaTournamentEntry.leagueId as LeagueId,
  entryId: prismaTournamentEntry.entryId as EntryId,
});

export const mapDomainTournamentEntryToPrismaCreate = (
  domainTournamentEntry: TournamentEntryCreateInput,
): PrismaTournamentEntryCreateInput => ({
  tournamentId: domainTournamentEntry.tournamentId,
  leagueId: domainTournamentEntry.leagueId,
  entryId: domainTournamentEntry.entryId,
});
