import type { ElementTypeId, EventId, PlayerId, TeamId } from '../types/base.type';

export interface EventLiveSummary {
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly elementType: ElementTypeId;
  readonly teamId: TeamId;
  readonly minutes: number;
  readonly goalsScored: number;
  readonly assists: number;
  readonly cleanSheets: number;
  readonly goalsConceded: number;
  readonly ownGoals: number;
  readonly penaltiesSaved: number;
  readonly penaltiesMissed: number;
  readonly yellowCards: number;
  readonly redCards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly totalPoints: number;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export type EventLiveSummaries = readonly EventLiveSummary[];
