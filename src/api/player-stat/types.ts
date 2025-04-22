import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import { APIError } from 'src/types/error.type';

export interface PlayerStatHandlerResponse {
  readonly getPlayerStats: () => TaskEither<APIError, PlayerStats>;
  readonly syncPlayerStats: () => TaskEither<APIError, void>;
  readonly getPlayerStat: (req: Request) => TaskEither<APIError, PlayerStat>;
  readonly getPlayerStatsByElementType: (req: Request) => TaskEither<APIError, PlayerStats>;
  readonly getPlayerStatsByTeam: (req: Request) => TaskEither<APIError, PlayerStats>;
}
