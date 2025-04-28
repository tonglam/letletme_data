import { ElementTypeId, ElementTypeName } from 'types/base.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export interface PlayerStat {
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly webName: string;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly totalPoints: number | null;
  readonly form: string | null;
  readonly influence: string | null;
  readonly creativity: string | null;
  readonly threat: string | null;
  readonly ictIndex: string | null;
  readonly expectedGoals: string | null;
  readonly expectedAssists: string | null;
  readonly expectedGoalInvolvements: string | null;
  readonly expectedGoalsConceded: string | null;
  readonly minutes: number | null;
  readonly goalsScored: number | null;
  readonly assists: number | null;
  readonly cleanSheets: number | null;
  readonly goalsConceded: number | null;
  readonly ownGoals: number | null;
  readonly penaltiesSaved: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly saves: number | null;
  readonly bonus: number | null;
  readonly bps: number | null;
  readonly starts: number | null;
  readonly influenceRank: number | null;
  readonly influenceRankType: number | null;
  readonly creativityRank: number | null;
  readonly creativityRankType: number | null;
  readonly threatRank: number | null;
  readonly threatRankType: number | null;
  readonly ictIndexRank: number | null;
  readonly ictIndexRankType: number | null;
  readonly mngWin: number | null;
  readonly mngDraw: number | null;
  readonly mngLoss: number | null;
  readonly mngUnderdogWin: number | null;
  readonly mngUnderdogDraw: number | null;
  readonly mngCleanSheets: number | null;
  readonly mngGoalsScored: number | null;
}

export type PlayerStats = readonly PlayerStat[];

export type RawPlayerStat = Omit<
  PlayerStat,
  'webName' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName' | 'value'
>;
export type RawPlayerStats = readonly RawPlayerStat[];
