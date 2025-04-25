import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';

import { Player, Players } from '../../types/domain/player.type';
import { APIError } from '../../types/error.type';

export interface PlayerHandlerResponse {
  readonly getAllPlayers: () => TaskEither<APIError, Players>;
  readonly getPlayerByElement: (req: Request) => TaskEither<APIError, Player>;
}
