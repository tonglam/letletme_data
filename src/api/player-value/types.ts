import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { PlayerValues } from 'src/types/domain/player-value.type';
import { APIError } from 'src/types/error.type';

export interface PlayerValueHandlerResponse {
  readonly getPlayerValuesByChangeDate: (req: Request) => TaskEither<APIError, PlayerValues>;
  readonly getPlayerValuesByElement: (req: Request) => TaskEither<APIError, PlayerValues>;
  readonly getPlayerValuesByTeam: (req: Request) => TaskEither<APIError, PlayerValues>;
  readonly syncPlayerValues: () => TaskEither<APIError, void>;
}
