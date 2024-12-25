import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../infrastructure/api/common/errors';

// ============ Branded Types ============
declare const PhaseIdBrand: unique symbol;
export type PhaseId = number & { readonly _brand: typeof PhaseIdBrand };

declare const EventIdBrand: unique symbol;
export type EventId = number & { readonly _brand: typeof EventIdBrand };

// ============ Domain Types ============
export interface Phase {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}

// ============ Persistence Types ============
export interface PrismaPhase {
  readonly id: number;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
  readonly createdAt: Date;
}

export interface PrismaPhaseCreate extends Omit<PrismaPhase, 'id'> {
  readonly id?: number;
}

// ============ Type Guards & Validation ============
export const isPhaseId = (id: unknown): id is PhaseId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validatePhaseId = (id: number): E.Either<string, PhaseId> =>
  isPhaseId(id) ? E.right(id as PhaseId) : E.left(`Invalid phase ID: ${id}`);

export const isEventId = (id: unknown): id is EventId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validateEventId = (id: number): E.Either<string, EventId> =>
  isEventId(id) ? E.right(id as EventId) : E.left(`Invalid event ID: ${id}`);

export const isValidPhase = (phase: Phase): boolean =>
  isPhaseId(phase.id) &&
  typeof phase.name === 'string' &&
  phase.name.length > 0 &&
  Number.isInteger(phase.startEvent) &&
  phase.startEvent > 0 &&
  Number.isInteger(phase.stopEvent) &&
  phase.stopEvent >= phase.startEvent &&
  (phase.highestScore === null ||
    (typeof phase.highestScore === 'number' && phase.highestScore >= 0));

export interface PhaseRepository {
  prisma: PrismaClient;
  findById(id: PhaseId): TE.TaskEither<APIError, PrismaPhase | null>;
  findAll(): TE.TaskEither<APIError, PrismaPhase[]>;
  save(data: PrismaPhaseCreate): TE.TaskEither<APIError, PrismaPhase>;
  saveBatch(data: PrismaPhaseCreate[]): TE.TaskEither<APIError, PrismaPhase[]>;
  update(id: PhaseId, data: Partial<PrismaPhaseCreate>): TE.TaskEither<APIError, PrismaPhase>;
  deleteAll(): TE.TaskEither<APIError, void>;
  findByIds(ids: PhaseId[]): TE.TaskEither<APIError, PrismaPhase[]>;
  deleteByIds(ids: PhaseId[]): TE.TaskEither<APIError, void>;
}
