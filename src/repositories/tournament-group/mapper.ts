import {
  PrismaTournamentGroup,
  PrismaTournamentGroupCreateInput,
  TournamentGroupCreateInput,
} from 'src/repositories/tournament-group/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentGroupId } from 'src/types/domain/tournament-group.type';
import { TournamentGroup } from 'src/types/domain/tournament-group.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export const mapPrismaTournamentGroupToDomain = (
  prismaTournamentGroup: PrismaTournamentGroup,
): TournamentGroup => ({
  tournamentId: prismaTournamentGroup.tournamentId as TournamentId,
  groupId: prismaTournamentGroup.groupId as TournamentGroupId,
  groupName: prismaTournamentGroup.groupName,
  groupIndex: prismaTournamentGroup.groupIndex,
  entryId: prismaTournamentGroup.entryId as EntryId,
  startedEventId: prismaTournamentGroup.startedEventId as EventId | null,
  endedEventId: prismaTournamentGroup.endedEventId as EventId | null,
  groupPoints: prismaTournamentGroup.groupPoints ?? 0,
  groupRank: prismaTournamentGroup.groupRank ?? 0,
  played: prismaTournamentGroup.played ?? 0,
  won: prismaTournamentGroup.won ?? 0,
  drawn: prismaTournamentGroup.drawn ?? 0,
  lost: prismaTournamentGroup.lost ?? 0,
  totalPoints: prismaTournamentGroup.totalPoints ?? 0,
  totalTransfersCost: prismaTournamentGroup.totalTransfersCost ?? 0,
  totalNetPoints: prismaTournamentGroup.totalNetPoints ?? 0,
  qualified: prismaTournamentGroup.qualified ?? 0,
  overallRank: prismaTournamentGroup.overallRank ?? 0,
});

export const mapDomainTournamentGroupToPrismaCreate = (
  domainTournamentGroup: TournamentGroupCreateInput,
): PrismaTournamentGroupCreateInput => ({
  tournamentId: domainTournamentGroup.tournamentId,
  groupId: domainTournamentGroup.groupId,
  groupName: domainTournamentGroup.groupName,
  groupIndex: domainTournamentGroup.groupIndex,
  entryId: domainTournamentGroup.entryId,
  startedEventId: domainTournamentGroup.startedEventId,
  endedEventId: domainTournamentGroup.endedEventId,
  groupPoints: domainTournamentGroup.groupPoints,
  groupRank: domainTournamentGroup.groupRank,
  played: domainTournamentGroup.played,
  won: domainTournamentGroup.won,
  drawn: domainTournamentGroup.drawn,
  lost: domainTournamentGroup.lost,
  totalPoints: domainTournamentGroup.totalPoints,
  totalTransfersCost: domainTournamentGroup.totalTransfersCost,
  totalNetPoints: domainTournamentGroup.totalNetPoints,
  qualified: domainTournamentGroup.qualified,
  overallRank: domainTournamentGroup.overallRank,
});
