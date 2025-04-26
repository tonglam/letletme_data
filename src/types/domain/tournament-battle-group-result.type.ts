import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

export type TournamentBattleGroupResult = {
  readonly tournamentId: TournamentId;
  readonly groupId: number;
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
