import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentGroupId } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export type TournamentPointsGroupResult = {
  readonly tournamentId: TournamentId;
  readonly groupId: TournamentGroupId;
  readonly eventId: EventId;
  readonly entryId: EntryId;
  readonly eventGroupRank: number | null;
  readonly eventPoints: number | null;
  readonly eventCost: number | null;
  readonly eventNetPoints: number | null;
  readonly eventRank: number | null;
};

export type TournamentPointsGroupResults = readonly TournamentPointsGroupResult[];
