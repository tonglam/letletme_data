import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export type TournamentPointsGroupResult = {
  readonly tournamentId: TournamentId;
  readonly groupId: number;
  readonly eventId: EventId;
  readonly entryId: EntryId;
  readonly eventGroupRank: number | null;
  readonly eventPoints: number | null;
  readonly eventCost: number | null;
  readonly eventNetPoints: number | null;
  readonly eventRank: number | null;
};

export type TournamentPointsGroupResults = readonly TournamentPointsGroupResult[];
