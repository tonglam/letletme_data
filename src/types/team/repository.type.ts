import * as TE from 'fp-ts/TaskEither';
import { DBError } from '../error.type';
import { Team, TeamId } from '../team.type';

export interface TeamRepository {
  readonly findById: (id: TeamId) => TE.TaskEither<DBError, Team | null>;
  readonly findAll: () => TE.TaskEither<DBError, Team[]>;
}
