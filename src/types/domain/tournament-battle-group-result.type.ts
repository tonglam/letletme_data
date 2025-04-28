import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { TournamentGroupId } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';

export type TournamentBattleGroupResult = {
  readonly tournamentId: TournamentId;
  readonly groupId: TournamentGroupId;
  readonly eventId: EventId;
  readonly homeIndex: number;
  readonly homeEntryId: EntryId;
  readonly homeNetPoints: number | null;
  readonly homeRank: number | null;
  readonly homeMatchPoints: number | null;
  readonly awayIndex: number;
  readonly awayEntryId: EntryId;
  readonly awayNetPoints: number | null;
  readonly awayRank: number | null;
  readonly awayMatchPoints: number | null;
};

export type TournamentBattleGroupResults = readonly TournamentBattleGroupResult[];
