import {
  DbTournamentPointsGroupResult,
  DbTournamentPointsGroupResultCreateInput,
  TournamentPointsGroupResultCreateInput,
} from 'repository/tournament-points-group-result/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentGroupId } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentPointsGroupResult } from 'types/domain/tournament-points-group-result.type';

export const mapDbTournamentPointsGroupResultToDomain = (
  dbTournamentPointsGroupResult: DbTournamentPointsGroupResult,
): TournamentPointsGroupResult => ({
  tournamentId: dbTournamentPointsGroupResult.tournamentId as TournamentId,
  groupId: dbTournamentPointsGroupResult.groupId as TournamentGroupId,
  eventId: dbTournamentPointsGroupResult.eventId as EventId,
  entryId: dbTournamentPointsGroupResult.entryId as EntryId,
  eventGroupRank: dbTournamentPointsGroupResult.eventGroupRank,
  eventPoints: dbTournamentPointsGroupResult.eventPoints,
  eventCost: dbTournamentPointsGroupResult.eventCost,
  eventNetPoints: dbTournamentPointsGroupResult.eventNetPoints,
  eventRank: dbTournamentPointsGroupResult.eventRank,
});

export const mapDomainTournamentPointsGroupResultToDbCreate = (
  domainTournamentPointsGroupResult: TournamentPointsGroupResultCreateInput,
): DbTournamentPointsGroupResultCreateInput => ({
  tournamentId: domainTournamentPointsGroupResult.tournamentId,
  groupId: domainTournamentPointsGroupResult.groupId,
  eventId: domainTournamentPointsGroupResult.eventId,
  entryId: domainTournamentPointsGroupResult.entryId,
  eventGroupRank: domainTournamentPointsGroupResult.eventGroupRank,
  eventPoints: domainTournamentPointsGroupResult.eventPoints,
  eventCost: domainTournamentPointsGroupResult.eventCost,
  eventNetPoints: domainTournamentPointsGroupResult.eventNetPoints,
  eventRank: domainTournamentPointsGroupResult.eventRank,
});
