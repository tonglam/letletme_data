import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/phase.schema';
import { Phase, PhaseId, Phases } from 'types/domain/phase.type';
import { DBError } from 'types/error.type';

export type DbPhase = InferSelectModel<typeof schema.phases>;
export type DbPhaseCreateInput = InferInsertModel<typeof schema.phases>;

export type PhaseCreateInput = Omit<Phase, 'id'> & { id: PhaseId };
export type PhaseCreateInputs = readonly PhaseCreateInput[];
export interface PhaseRepository {
  readonly findById: (id: PhaseId) => TE.TaskEither<DBError, Phase>;
  readonly findAll: () => TE.TaskEither<DBError, Phases>;
  readonly saveBatch: (phaseInputs: PhaseCreateInputs) => TE.TaskEither<DBError, Phases>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
