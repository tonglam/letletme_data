import {
  PrismaTournamentBattleGroupResult,
  PrismaTournamentBattleGroupResultCreateInput,
  TournamentBattleGroupResultCreateInput,
} from 'src/repositories/tournament-battle-group-result/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentBattleGroupResult } from 'src/types/domain/tournament-battle-group-result.type';
import { TournamentGroupId } from 'src/types/domain/tournament-group.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export const mapPrismaTournamentBattleGroupResultToDomain = (
  prismaTournamentBattleGroupResult: PrismaTournamentBattleGroupResult,
): TournamentBattleGroupResult => ({
  tournamentId: prismaTournamentBattleGroupResult.tournamentId as TournamentId,
  groupId: prismaTournamentBattleGroupResult.groupId as TournamentGroupId,
  eventId: prismaTournamentBattleGroupResult.eventId as EventId,
  homeIndex: prismaTournamentBattleGroupResult.homeIndex,
  homeEntryId: prismaTournamentBattleGroupResult.homeEntryId as EntryId,
  homeNetPoints: prismaTournamentBattleGroupResult.homeNetPoints,
  homeRank: prismaTournamentBattleGroupResult.homeRank,
  homeMatchPoints: prismaTournamentBattleGroupResult.homeMatchPoints,
  awayIndex: prismaTournamentBattleGroupResult.awayIndex,
  awayEntryId: prismaTournamentBattleGroupResult.awayEntryId as EntryId,
  awayNetPoints: prismaTournamentBattleGroupResult.awayNetPoints,
  awayRank: prismaTournamentBattleGroupResult.awayRank,
  awayMatchPoints: prismaTournamentBattleGroupResult.awayMatchPoints,
});

export const mapDomainTournamentBattleGroupResultToPrismaCreate = (
  domainTournamentBattleGroupResult: TournamentBattleGroupResultCreateInput,
): PrismaTournamentBattleGroupResultCreateInput => ({
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
