import { PhaseID } from '@app/domain/types/id.types';

export interface PhaseModel {
  readonly id: PhaseID;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number;
}
