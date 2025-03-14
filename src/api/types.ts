// Core type definitions for API layer including request/response structures,
// pagination, sorting, and metadata interfaces.

import { NextFunction, Request, Response } from 'express';
import { Either } from 'fp-ts/Either';
import { TaskEither } from 'fp-ts/TaskEither';
import { APIError } from 'src/types/error.type';
import { Event, Events } from '../types/event.type';
import { Phase, Phases } from '../types/phase.type';
import { PlayerStat } from '../types/player-stat.type';
import { PlayerValue } from '../types/player-value.type';
import { Player } from '../types/player.type';
import { Team, Teams } from '../types/team.type';

// Standard API response format with generic data payload
export interface APIResponseData<T> {
  readonly data: T;
}

// Generic handler for nullable values
export type NullableHandler<T> = (message: string) => (value: T | null) => Either<APIError, T>;

// Handler for nullable event responses
export type NullableEventHandler = NullableHandler<Event>;

// Event handler responses defining all available event operations
export interface EventHandlerResponse {
  readonly getAllEvents: () => TaskEither<APIError, Events>;
  readonly getCurrentEvent: () => TaskEither<APIError, Event>;
  readonly getNextEvent: () => TaskEither<APIError, Event>;
  readonly getEventById: (req: Request) => TaskEither<APIError, Event>;
}

// Phase handler response types
export interface PhaseHandlerResponse {
  readonly getAllPhases: () => TaskEither<APIError, Phases>;
  readonly getPhaseById: (req: Request) => TaskEither<APIError, Phase>;
}

// Team handler response types
export interface TeamHandlerResponse {
  readonly getAllTeams: () => TaskEither<APIError, Teams>;
  readonly getTeamById: (req: Request) => TaskEither<APIError, Team>;
}

// Handler for asynchronous middleware operations
export type AsyncMiddlewareHandler<T> = (req: Request) => TaskEither<APIError, T>;

// Extended Request type for API operations
export type ApiRequest = Request;

// Handler for asynchronous operations
export type AsyncHandler<T> = (req: ApiRequest) => Promise<Either<APIError, T>>;

// Async Either type alias for TaskEither operations
export type AsyncEither<E, A> = Promise<Either<E, A>>;

// Express middleware type
export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

// Error handler middleware type
export type ErrorHandler = (error: Error, req: Request, res: Response, next: NextFunction) => void;

// Security headers interface
export interface SecurityHeaders {
  readonly 'X-Content-Type-Options': string;
  readonly 'X-Frame-Options': string;
  readonly 'X-XSS-Protection': string;
  readonly 'Strict-Transport-Security': string;
}

// Player handler response type
export interface PlayerHandlerResponse {
  readonly getAllPlayers: () => TaskEither<APIError, Player[]>;
  readonly getPlayerById: (req: Request) => TaskEither<APIError, Player>;
}

// Player value handler response type
export interface PlayerValueHandlerResponse {
  readonly getAllPlayerValues: () => TaskEither<APIError, PlayerValue[]>;
  readonly getPlayerValueById: (req: Request) => TaskEither<APIError, PlayerValue>;
}

// Player stat handler response type
export interface PlayerStatHandlerResponse {
  readonly getAllPlayerStats: () => TaskEither<APIError, PlayerStat[]>;
  readonly getPlayerStatById: (req: Request) => TaskEither<APIError, PlayerStat>;
}
