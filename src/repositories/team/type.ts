import { Prisma, Team as PrismaTeamType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError } from 'src/types/error.type';

import { Team, TeamId, Teams } from '../../types/domain/team.type';

export type PrismaTeamCreateInput = Prisma.TeamCreateInput;
export type PrismaTeam = PrismaTeamType;

export type TeamCreateInput = Omit<Team, 'id'> & { id: TeamId };
export type TeamCreateInputs = readonly TeamCreateInput[];

export interface TeamRepository {
  readonly findById: (id: TeamId) => TE.TaskEither<DBError, Team>;
  readonly findAll: () => TE.TaskEither<DBError, Teams>;
  readonly saveBatch: (data: TeamCreateInputs) => TE.TaskEither<DBError, Teams>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
