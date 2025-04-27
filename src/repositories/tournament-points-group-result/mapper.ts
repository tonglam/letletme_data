import {
  PrismaTournamentPointsGroupResult,
  PrismaTournamentPointsGroupResultCreateInput,
  TournamentPointsGroupResultCreateInput,
} from 'src/repositories/tournament-points-group-result/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentGroupId } from 'src/types/domain/tournament-group.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentPointsGroupResult } from 'src/types/domain/tournament-points-group-result.type';

export const mapPrismaTournamentPointsGroupResultToDomain = (
  prismaTournamentPointsGroupResult: PrismaTournamentPointsGroupResult,
): TournamentPointsGroupResult => ({
  tournamentId: prismaTournamentPointsGroupResult.tournamentId as TournamentId,
  groupId: prismaTournamentPointsGroupResult.groupId as TournamentGroupId,
  eventId: prismaTournamentPointsGroupResult.eventId as EventId,
  entryId: prismaTournamentPointsGroupResult.entryId as EntryId,
  eventGroupRank: prismaTournamentPointsGroupResult.eventGroupRank,
  eventPoints: prismaTournamentPointsGroupResult.eventPoints,
  eventCost: prismaTournamentPointsGroupResult.eventCost,
  eventNetPoints: prismaTournamentPointsGroupResult.eventNetPoints,
  eventRank: prismaTournamentPointsGroupResult.eventRank,
});

export const mapDomainTournamentPointsGroupResultToPrismaCreate = (
  domainTournamentPointsGroupResult: TournamentPointsGroupResultCreateInput,
): PrismaTournamentPointsGroupResultCreateInput => ({
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
