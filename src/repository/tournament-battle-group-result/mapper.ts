import {
  DbTournamentBattleGroupResult,
  DbTournamentBattleGroupResultCreateInput,
  TournamentBattleGroupResultCreateInput,
} from 'repository/tournament-battle-group-result/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentBattleGroupResult } from 'types/domain/tournament-battle-group-result.type';
import { TournamentGroupId } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export const mapDbTournamentBattleGroupResultToDomain = (
  dbTournamentBattleGroupResult: DbTournamentBattleGroupResult,
): TournamentBattleGroupResult => ({
  tournamentId: dbTournamentBattleGroupResult.tournamentId as TournamentId,
  groupId: dbTournamentBattleGroupResult.groupId as TournamentGroupId,
  eventId: dbTournamentBattleGroupResult.eventId as EventId,
  homeIndex: dbTournamentBattleGroupResult.homeIndex,
  homeEntryId: dbTournamentBattleGroupResult.homeEntryId as EntryId,
  homeNetPoints: dbTournamentBattleGroupResult.homeNetPoints,
  homeRank: dbTournamentBattleGroupResult.homeRank,
  homeMatchPoints: dbTournamentBattleGroupResult.homeMatchPoints,
  awayIndex: dbTournamentBattleGroupResult.awayIndex,
  awayEntryId: dbTournamentBattleGroupResult.awayEntryId as EntryId,
  awayNetPoints: dbTournamentBattleGroupResult.awayNetPoints,
  awayRank: dbTournamentBattleGroupResult.awayRank,
  awayMatchPoints: dbTournamentBattleGroupResult.awayMatchPoints,
});

export const mapDomainTournamentBattleGroupResultToDbCreate = (
  domainTournamentBattleGroupResult: TournamentBattleGroupResultCreateInput,
): DbTournamentBattleGroupResultCreateInput => ({
  tournamentId: domainTournamentBattleGroupResult.tournamentId,
  groupId: domainTournamentBattleGroupResult.groupId,
  eventId: domainTournamentBattleGroupResult.eventId,
  homeIndex: domainTournamentBattleGroupResult.homeIndex,
  homeEntryId: domainTournamentBattleGroupResult.homeEntryId,
  homeNetPoints: domainTournamentBattleGroupResult.homeNetPoints,
  homeRank: domainTournamentBattleGroupResult.homeRank,
  homeMatchPoints: domainTournamentBattleGroupResult.homeMatchPoints,
  awayIndex: domainTournamentBattleGroupResult.awayIndex,
  awayEntryId: domainTournamentBattleGroupResult.awayEntryId,
  awayNetPoints: domainTournamentBattleGroupResult.awayNetPoints,
  awayRank: domainTournamentBattleGroupResult.awayRank,
  awayMatchPoints: domainTournamentBattleGroupResult.awayMatchPoints,
});
