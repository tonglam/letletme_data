import {
  TournamentGroupCreateInput,
  DbTournamentGroup,
  DbTournamentGroupCreateInput,
} from 'repositories/tournament-group/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentGroupId } from 'types/domain/tournament-group.type';
import { TournamentGroup } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export const mapDbTournamentGroupToDomain = (
  dbTournamentGroup: DbTournamentGroup,
): TournamentGroup => ({
  tournamentId: dbTournamentGroup.tournamentId as TournamentId,
  groupId: dbTournamentGroup.groupId as TournamentGroupId,
  groupName: dbTournamentGroup.groupName,
  groupIndex: dbTournamentGroup.groupIndex,
  entryId: dbTournamentGroup.entryId as EntryId,
  startedEventId: dbTournamentGroup.startedEventId as EventId | null,
  endedEventId: dbTournamentGroup.endedEventId as EventId | null,
  groupPoints: dbTournamentGroup.groupPoints ?? 0,
  groupRank: dbTournamentGroup.groupRank ?? 0,
  played: dbTournamentGroup.played ?? 0,
  won: dbTournamentGroup.won ?? 0,
  drawn: dbTournamentGroup.drawn ?? 0,
  lost: dbTournamentGroup.lost ?? 0,
  totalPoints: dbTournamentGroup.totalPoints ?? 0,
  totalTransfersCost: dbTournamentGroup.totalTransfersCost ?? 0,
  totalNetPoints: dbTournamentGroup.totalNetPoints ?? 0,
  qualified: dbTournamentGroup.qualified ?? 0,
  overallRank: dbTournamentGroup.overallRank ?? 0,
});

export const mapDomainTournamentGroupToDbCreate = (
  domainTournamentGroup: TournamentGroupCreateInput,
): DbTournamentGroupCreateInput => ({
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
