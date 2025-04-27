import {
  PrismaTournamentKnockoutResult,
  PrismaTournamentKnockoutResultCreateInput,
  TournamentKnockoutResultCreateInput,
} from 'src/repositories/tournament-knockout-result/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentKnockoutResult } from 'src/types/domain/tournament-knockout-result.type';

export const mapPrismaTournamentKnockoutResultToDomain = (
  prismaTournamentKnockoutResult: PrismaTournamentKnockoutResult,
): TournamentKnockoutResult => ({
  tournamentId: prismaTournamentKnockoutResult.tournamentId as TournamentId,
  eventId: prismaTournamentKnockoutResult.eventId as EventId,
  matchId: prismaTournamentKnockoutResult.matchId,
  playAgainstId: prismaTournamentKnockoutResult.playAgainstId,
  homeEntryId: prismaTournamentKnockoutResult.homeEntryId as EntryId,
  homeNetPoints: prismaTournamentKnockoutResult.homeNetPoints,
  homeGoalsScored: prismaTournamentKnockoutResult.homeGoalsScored,
  homeGoalsConceded: prismaTournamentKnockoutResult.homeGoalsConceded,
  awayEntryId: prismaTournamentKnockoutResult.awayEntryId as EntryId,
  awayNetPoints: prismaTournamentKnockoutResult.awayNetPoints,
  awayGoalsScored: prismaTournamentKnockoutResult.awayGoalsScored,
  awayGoalsConceded: prismaTournamentKnockoutResult.awayGoalsConceded,
  matchWinner: prismaTournamentKnockoutResult.matchWinner,
});

export const mapDomainTournamentKnockoutResultToPrismaCreate = (
  domainTournamentKnockoutResult: TournamentKnockoutResultCreateInput,
): PrismaTournamentKnockoutResultCreateInput => ({
  tournamentId: domainTournamentKnockoutResult.tournamentId,
  eventId: domainTournamentKnockoutResult.eventId,
  matchId: domainTournamentKnockoutResult.matchId,
  playAgainstId: domainTournamentKnockoutResult.playAgainstId,
  homeEntryId: domainTournamentKnockoutResult.homeEntryId,
  homeNetPoints: domainTournamentKnockoutResult.homeNetPoints,
  homeGoalsScored: domainTournamentKnockoutResult.homeGoalsScored,
  homeGoalsConceded: domainTournamentKnockoutResult.homeGoalsConceded,
  awayEntryId: domainTournamentKnockoutResult.awayEntryId,
  awayNetPoints: domainTournamentKnockoutResult.awayNetPoints,
  awayGoalsScored: domainTournamentKnockoutResult.awayGoalsScored,
  awayGoalsConceded: domainTournamentKnockoutResult.awayGoalsConceded,
  matchWinner: domainTournamentKnockoutResult.matchWinner,
});
