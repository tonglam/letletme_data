import { BaseEntity, EventStatus, FixtureStatus } from '../base/types';

/**
 * Core event model
 */
export interface Event extends BaseEntity {
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: string | null;
  readonly status: EventStatus;
  readonly averageEntryScore: number;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly isFinished: boolean;
  readonly dataChecked: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: ReadonlyArray<ChipPlay>;
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
  readonly transfersMade: number;
}

/**
 * Event fixture model
 */
export interface EventFixture extends BaseEntity {
  readonly eventId: number;
  readonly homeTeamId: number;
  readonly awayTeamId: number;
  readonly kickoffTime: string;
  readonly status: FixtureStatus;
  readonly homeScore?: number;
  readonly awayScore?: number;
  readonly stats: FixtureStats;
}

/**
 * Event live stats
 */
export interface EventLive {
  readonly eventId: number;
  readonly elementId: number; // Player ID
  readonly stats: EventPlayerStats;
  readonly explain: ReadonlyArray<ExplainStats>;
}

/**
 * Fixture statistics
 */
export interface FixtureStats {
  readonly goals: ReadonlyArray<GoalEvent>;
  readonly cards: ReadonlyArray<CardEvent>;
  readonly saves: ReadonlyArray<SaveEvent>;
  readonly bonus: ReadonlyArray<BonusPoints>;
}

/**
 * Player statistics in an event
 */
export interface EventPlayerStats {
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
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ictIndex: string;
  readonly totalPoints: number;
  readonly inDreamteam: boolean;
}

/**
 * Chip play information
 */
export interface ChipPlay {
  readonly chipName: string;
  readonly numPlayed: number;
}

/**
 * Top element information
 */
export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

/**
 * Explanation of bonus points
 */
export interface ExplainStats {
  readonly name: string;
  readonly points: number;
  readonly value: number;
}

// Event-specific types
export interface GoalEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'normal' | 'penalty' | 'own';
}

export interface CardEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'yellow' | 'red';
}

export interface SaveEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'penalty' | 'normal';
}

export interface BonusPoints {
  readonly playerId: number;
  readonly points: 1 | 2 | 3;
}

/**
 * Event operation results
 */
export interface EventResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

export interface EventUpdateResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface EventQueryResult {
  readonly currentEventId: number;
  readonly isValid: boolean;
  readonly error?: string;
}

export interface EventDeadline {
  readonly id: number;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
}

// Type guards
export const isEventDeadline = (value: unknown): value is EventDeadline => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'deadlineTime' in value &&
    'deadlineTimeEpoch' in value
  );
};
