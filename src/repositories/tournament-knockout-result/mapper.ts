import {
  DbTournamentKnockoutResult,
  DbTournamentKnockoutResultCreateInput,
  TournamentKnockoutResultCreateInput,
} from 'repositories/tournament-knockout-result/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockoutResult } from 'types/domain/tournament-knockout-result.type';

export const mapDbTournamentKnockoutResultToDomain = (
  dbTournamentKnockoutResult: DbTournamentKnockoutResult,
): TournamentKnockoutResult => ({
  tournamentId: dbTournamentKnockoutResult.tournamentId as TournamentId,
  eventId: dbTournamentKnockoutResult.eventId as EventId,
  matchId: dbTournamentKnockoutResult.matchId,
  playAgainstId: dbTournamentKnockoutResult.playAgainstId,
  homeEntryId: dbTournamentKnockoutResult.homeEntryId as EntryId,
  homeNetPoints: dbTournamentKnockoutResult.homeNetPoints,
  homeGoalsScored: dbTournamentKnockoutResult.homeGoalsScored,
  homeGoalsConceded: dbTournamentKnockoutResult.homeGoalsConceded,
  awayEntryId: dbTournamentKnockoutResult.awayEntryId as EntryId,
  awayNetPoints: dbTournamentKnockoutResult.awayNetPoints,
  awayGoalsScored: dbTournamentKnockoutResult.awayGoalsScored,
  awayGoalsConceded: dbTournamentKnockoutResult.awayGoalsConceded,
  matchWinner: dbTournamentKnockoutResult.matchWinner,
});

export const mapDomainTournamentKnockoutResultToDbCreate = (
  domainTournamentKnockoutResult: TournamentKnockoutResultCreateInput,
): DbTournamentKnockoutResultCreateInput => ({
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
