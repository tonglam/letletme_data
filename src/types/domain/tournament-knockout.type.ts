import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export type TournamentKnockout = {
  readonly tournamentId: TournamentId;
  readonly round: number;
  readonly startedEventId: EventId | null;
  readonly endedEventId: EventId | null;
  readonly matchId: number;
  readonly nextMatchId: number | null;
  readonly homeEntryId: PlayerId | null;
  readonly homeNetPoints: number | null;
  readonly homeGoalsScored: number | null;
  readonly homeGoalsConceded: number | null;
  readonly homeWins: number | null;
  readonly awayEntryId: PlayerId | null;
  readonly awayNetPoints: number | null;
  readonly awayGoalsScored: number | null;
  readonly awayGoalsConceded: number | null;
  readonly awayWins: number | null;
  readonly roundWinner: number | null;
};

export type TournamentKnockouts = readonly TournamentKnockout[];
