import { BaseEntity, EventStatus, FixtureStatus } from '../base/types';

/**
 * Core event model
 */
export interface Event extends BaseEntity {
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly status: EventStatus;
  readonly averagePoints: number;
  readonly highestPoints: number;
  readonly isFinished: boolean;
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
  readonly goals: number;
  readonly assists: number;
  readonly cleanSheet: boolean;
  readonly saves: number;
  readonly bonus: number;
  readonly totalPoints: number;
}

// Event-specific types
interface GoalEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'normal' | 'penalty' | 'own';
}

interface CardEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'yellow' | 'red';
}

interface SaveEvent {
  readonly playerId: number;
  readonly minute: number;
  readonly type: 'penalty' | 'normal';
}

interface BonusPoints {
  readonly playerId: number;
  readonly points: 1 | 2 | 3;
}
