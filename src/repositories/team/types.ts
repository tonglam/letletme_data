import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/team';
import { Team, TeamId, Teams } from 'types/domain/team.type';
import { DBError } from 'types/error.type';

export type DbTeam = InferSelectModel<typeof schema.teams>;
export type DbTeamCreateInput = InferInsertModel<typeof schema.teams>;

export type TeamCreateInput = Omit<Team, 'id'> & { id: TeamId };
export type TeamCreateInputs = readonly TeamCreateInput[];

export interface TeamRepository {
  readonly findById: (id: TeamId) => TE.TaskEither<DBError, Team>;
  readonly findAll: () => TE.TaskEither<DBError, Teams>;
  readonly saveBatch: (teamInputs: TeamCreateInputs) => TE.TaskEither<DBError, Teams>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
