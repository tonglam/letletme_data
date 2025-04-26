import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export type TournamentGroup = {
  readonly tournamentId: TournamentId;
  readonly groupId: number;
  readonly groupName: string;
  readonly groupIndex: number;
  readonly entryId: EntryId;
  readonly startedEventId: EventId | null;
  readonly endedEventId: EventId | null;
  readonly groupPoints: number | null;
  readonly groupRank: number | null;
  readonly played: number | null;
  readonly win: number | null;
  readonly draw: number | null;
  readonly loss: number | null;
  readonly totalPoints: number | null;
  readonly totalTransfersCost: number | null;
  readonly totalNetPoints: number | null;
  readonly qualified: number | null;
  readonly overallRank: number | null;
};

export type TournamentGroups = readonly TournamentGroup[];
