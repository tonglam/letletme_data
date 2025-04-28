import {
  TournamentKnockoutCreateInput,
  DbTournamentKnockout,
  DbTournamentKnockoutCreateInput,
} from 'repositories/tournament-knockout/types';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockout } from 'types/domain/tournament-knockout.type';

export const mapDbTournamentKnockoutToDomain = (
  dbTournamentKnockout: DbTournamentKnockout,
): TournamentKnockout => ({
  tournamentId: dbTournamentKnockout.tournamentId as TournamentId,
  round: dbTournamentKnockout.round,
  startedEventId: dbTournamentKnockout.startedEventId as EventId | null,
  endedEventId: dbTournamentKnockout.endedEventId as EventId | null,
  matchId: dbTournamentKnockout.matchId,
  nextMatchId: dbTournamentKnockout.nextMatchId,
  homeEntryId: dbTournamentKnockout.homeEntryId as PlayerId | null,
  homeNetPoints: dbTournamentKnockout.homeNetPoints,
  homeGoalsScored: dbTournamentKnockout.homeGoalsScored,
  homeGoalsConceded: dbTournamentKnockout.homeGoalsConceded,
  homeWins: dbTournamentKnockout.homeWins,
  awayEntryId: dbTournamentKnockout.awayEntryId as PlayerId | null,
  awayNetPoints: dbTournamentKnockout.awayNetPoints,
  awayGoalsScored: dbTournamentKnockout.awayGoalsScored,
  awayGoalsConceded: dbTournamentKnockout.awayGoalsConceded,
  awayWins: dbTournamentKnockout.awayWins,
  roundWinner: dbTournamentKnockout.roundWinner,
});

export const mapDomainTournamentKnockoutToDbCreate = (
  domainTournamentKnockout: TournamentKnockoutCreateInput,
): DbTournamentKnockoutCreateInput => ({
  tournamentId: domainTournamentKnockout.tournamentId,
  round: domainTournamentKnockout.round,
  matchId: domainTournamentKnockout.matchId,
  startedEventId: domainTournamentKnockout.startedEventId,
  endedEventId: domainTournamentKnockout.endedEventId,
  nextMatchId: domainTournamentKnockout.nextMatchId,
  homeEntryId: domainTournamentKnockout.homeEntryId,
  homeNetPoints: domainTournamentKnockout.homeNetPoints,
  homeGoalsScored: domainTournamentKnockout.homeGoalsScored,
  homeGoalsConceded: domainTournamentKnockout.homeGoalsConceded,
  homeWins: domainTournamentKnockout.homeWins,
  awayEntryId: domainTournamentKnockout.awayEntryId,
  awayNetPoints: domainTournamentKnockout.awayNetPoints,
  awayGoalsScored: domainTournamentKnockout.awayGoalsScored,
  awayGoalsConceded: domainTournamentKnockout.awayGoalsConceded,
  awayWins: domainTournamentKnockout.awayWins,
  roundWinner: domainTournamentKnockout.roundWinner,
});
