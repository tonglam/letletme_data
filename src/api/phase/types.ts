import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { Phases } from 'src/types/domain/phase.type';
import { Phase } from 'src/types/domain/phase.type';

import { APIError } from '../../types/error.type';

export interface PhaseHandlerResponse {
  readonly getAllPhases: () => TaskEither<APIError, Phases>;
  readonly getPhaseById: (req: Request) => TaskEither<APIError, Phase>;
}
