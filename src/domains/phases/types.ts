import { BaseEntity } from '../base/types';

/**
 * Phase domain types
 */

// Raw phase data from FPL API
export interface RawPhase {
  readonly id: number;
  readonly name: string;
  readonly start_event: number;
  readonly stop_event: number;
}

// Domain model for Phase
export interface Phase extends BaseEntity {
  readonly name: string;
  readonly startEventId: number;
  readonly stopEventId: number;
}

// Phase without base entity fields for creation
export type PhaseCreate = Omit<Phase, keyof BaseEntity>;

// Repository operations result types
export interface PhaseRepository {
  save(phase: PhaseCreate): Promise<Phase>;
  findById(id: number): Promise<Phase | null>;
  findAll(): Promise<Phase[]>;
  update(id: number, phase: Partial<PhaseCreate>): Promise<Phase>;
}

// Operation result types
export type PhaseOperationResult<T> = {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
};
