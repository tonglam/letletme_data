import { Prisma, Phase as PrismaPhaseType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { Phase, PhaseId, Phases } from '../../types/domain/phase.type';

export type PrismaPhaseCreateInput = Prisma.PhaseCreateInput;
export type PrismaPhase = PrismaPhaseType;

export type PhaseCreateInput = Omit<Phase, 'id'> & { id: PhaseId };
export type PhaseCreateInputs = readonly PhaseCreateInput[];
export interface PhaseRepository {
  readonly findById: (id: PhaseId) => TE.TaskEither<DBError, Phase>;
  readonly findAll: () => TE.TaskEither<DBError, Phases>;
  readonly saveBatch: (phases: PhaseCreateInputs) => TE.TaskEither<DBError, Phases>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
