import * as TE from 'fp-ts/TaskEither';
import { DBError } from '../error.type';
import { Player, PlayerId } from '../player.type';
import { TeamId } from '../team.type';

export interface PlayerRepository {
  readonly findById: (id: PlayerId) => TE.TaskEither<DBError, Player | null>;
  readonly findAll: () => TE.TaskEither<DBError, Player[]>;
  readonly findByTeamId: (teamId: TeamId) => TE.TaskEither<DBError, Player[]>;
  readonly saveBatch: (players: readonly Player[]) => TE.TaskEither<DBError, Player[]>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
