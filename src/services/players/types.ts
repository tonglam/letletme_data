import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Player, PlayerId, Players } from '../../types/players.type';
import type { TeamId } from '../../types/teams.type';

export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<APIError, Players>;
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<APIError, Player | null>;
  readonly getPlayersByTeam: (teamId: TeamId) => TE.TaskEither<APIError, Players>;
}
