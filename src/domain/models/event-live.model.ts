import { ElementTypeId, ElementTypeName } from 'types/base.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export interface EventLive {
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly webName: string;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly value: number;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly minutes: number | null;
  readonly goalsScored: number | null;
  readonly assists: number | null;
  readonly cleanSheets: number | null;
  readonly goalsConceded: number | null;
  readonly ownGoals: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesMissed: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly saves: number | null;
  readonly bonus: number | null;
  readonly bps: number | null;
  readonly starts: boolean | null;
  readonly expectedGoals: string | null;
  readonly expectedAssists: string | null;
  readonly expectedGoalInvolvements: string | null;
  readonly expectedGoalsConceded: string | null;
  readonly mngWin: number | null;
  readonly mngDraw: number | null;
  readonly mngLoss: number | null;
  readonly mngUnderdogWin: number | null;
  readonly mngUnderdogDraw: number | null;
  readonly mngCleanSheets: number | null;
  readonly mngGoalsScored: number | null;
  readonly inDreamTeam: boolean | null;
  readonly totalPoints: number;
}

export type EventLives = readonly EventLive[];

export type RawEventLive = Omit<
  EventLive,
  'webName' | 'elementType' | 'elementTypeName' | 'value' | 'teamId' | 'teamName' | 'teamShortName'
>;
export type RawEventLives = readonly RawEventLive[];
