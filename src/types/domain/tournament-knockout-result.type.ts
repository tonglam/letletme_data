import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export type TournamentKnockoutResult = {
  readonly tournamentId: TournamentId;
  readonly eventId: EventId;
  readonly matchId: number;
  readonly playAgainstId: number;
  readonly homeEntryId: EntryId | null;
  readonly homeNetPoints: number | null;
  readonly homeGoalsScored: number | null;
  readonly homeGoalsConceded: number | null;
  readonly homeWins: number | null;
  readonly awayEntryId: EntryId | null;
  readonly awayNetPoints: number | null;
  readonly awayGoalsScored: number | null;
  readonly awayGoalsConceded: number | null;
  readonly awayWins: number | null;
  readonly roundWinner: number | null;
};

export type TournamentKnockoutResults = readonly TournamentKnockoutResult[];
