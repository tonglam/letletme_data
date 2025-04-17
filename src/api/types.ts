import { NextFunction, Request, Response } from 'express';
import { Either } from 'fp-ts/Either';
import { TaskEither } from 'fp-ts/TaskEither';
import { APIError } from 'src/types/error.type';
import { Event, Events } from '../types/domain/event.type';
import { Phase, Phases } from '../types/domain/phase.type';
import { PlayerStat } from '../types/domain/player-stat.type';
import { PlayerValue } from '../types/domain/player-value.type';
import { Player } from '../types/domain/player.type';
import { Team, Teams } from '../types/domain/team.type';

export interface APIResponseData<T> {
  readonly data: T;
}

export type NullableHandler<T> = (message: string) => (value: T | null) => Either<APIError, T>;

export type NullableEventHandler = NullableHandler<Event>;

export interface EventHandlerResponse {
  readonly getAllEvents: () => TaskEither<APIError, Events>;
  readonly getCurrentEvent: () => TaskEither<APIError, Event>;
  readonly getNextEvent: () => TaskEither<APIError, Event>;
  readonly getEventById: (req: Request) => TaskEither<APIError, Event>;
}

export interface PhaseHandlerResponse {
  readonly getAllPhases: () => TaskEither<APIError, Phases>;
  readonly getPhaseById: (req: Request) => TaskEither<APIError, Phase>;
}

export interface TeamHandlerResponse {
  readonly getAllTeams: () => TaskEither<APIError, Teams>;
  readonly getTeamById: (req: Request) => TaskEither<APIError, Team>;
}

export type AsyncMiddlewareHandler<T> = (req: Request) => TaskEither<APIError, T>;

export type ApiRequest = Request;

export type AsyncHandler<T> = (req: ApiRequest) => Promise<Either<APIError, T>>;

export type AsyncEither<E, A> = Promise<Either<E, A>>;

export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

export type ErrorHandler = (error: Error, req: Request, res: Response, next: NextFunction) => void;

export interface SecurityHeaders {
  readonly 'X-Content-Type-Options': string;
  readonly 'X-Frame-Options': string;
  readonly 'X-XSS-Protection': string;
  readonly 'Strict-Transport-Security': string;
}

export interface PlayerHandlerResponse {
  readonly getAllPlayers: () => TaskEither<APIError, Player[]>;
  readonly getPlayerById: (req: Request) => TaskEither<APIError, Player>;
}

export interface PlayerValueHandlerResponse {
  readonly getAllPlayerValues: () => TaskEither<APIError, PlayerValue[]>;
  readonly getPlayerValueById: (req: Request) => TaskEither<APIError, PlayerValue>;
}

export interface PlayerStatHandlerResponse {
  readonly getAllPlayerStats: () => TaskEither<APIError, PlayerStat[]>;
  readonly getPlayerStatById: (req: Request) => TaskEither<APIError, PlayerStat>;
}
