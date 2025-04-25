import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { Team, Teams } from 'src/types/domain/team.type';
import { APIError } from 'src/types/error.type';

export interface TeamHandlerResponse {
  readonly getAllTeams: () => TaskEither<APIError, Teams>;
  readonly getTeamById: (req: Request) => TaskEither<APIError, Team>;
}
