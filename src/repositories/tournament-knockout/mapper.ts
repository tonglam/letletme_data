import {
  PrismaTournamentKnockout,
  PrismaTournamentKnockoutCreateInput,
  TournamentKnockoutCreateInput,
} from 'src/repositories/tournament-knockout/types';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentKnockout } from 'src/types/domain/tournament-knockout.type';

export const mapPrismaTournamentKnockoutToDomain = (
  prismaTournamentKnockout: PrismaTournamentKnockout,
): TournamentKnockout => ({
  tournamentId: prismaTournamentKnockout.tournamentId as TournamentId,
  round: prismaTournamentKnockout.round,
  startedEventId: prismaTournamentKnockout.startedEventId as EventId | null,
  endedEventId: prismaTournamentKnockout.endedEventId as EventId | null,
  matchId: prismaTournamentKnockout.matchId,
  nextMatchId: prismaTournamentKnockout.nextMatchId,
  homeEntryId: prismaTournamentKnockout.homeEntryId as PlayerId | null,
  homeNetPoints: prismaTournamentKnockout.homeNetPoints,
  homeGoalsScored: prismaTournamentKnockout.homeGoalsScored,
  homeGoalsConceded: prismaTournamentKnockout.homeGoalsConceded,
  homeWins: prismaTournamentKnockout.homeWins,
  awayEntryId: prismaTournamentKnockout.awayEntryId as PlayerId | null,
  awayNetPoints: prismaTournamentKnockout.awayNetPoints,
  awayGoalsScored: prismaTournamentKnockout.awayGoalsScored,
  awayGoalsConceded: prismaTournamentKnockout.awayGoalsConceded,
  awayWins: prismaTournamentKnockout.awayWins,
  roundWinner: prismaTournamentKnockout.roundWinner,
});

export const mapDomainTournamentKnockoutToPrismaCreate = (
  domainTournamentKnockout: TournamentKnockoutCreateInput,
): PrismaTournamentKnockoutCreateInput => ({
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
