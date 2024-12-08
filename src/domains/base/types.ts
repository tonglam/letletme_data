/**
 * Common types used across domains
 */

// Position types
export type PlayerPosition = 'GKP' | 'DEF' | 'MID' | 'FWD';

// Chip types
export type ChipType = 'wildcard' | 'freehit' | 'bboost' | 'threexc';

// Status types
export type FixtureStatus = 'scheduled' | 'live' | 'finished';
export type EventStatus = 'upcoming' | 'current' | 'finished';

// Result types
export interface DomainResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

// Base entity type
export interface BaseEntity {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
