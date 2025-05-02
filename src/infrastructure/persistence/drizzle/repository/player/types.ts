import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/player.schema';
import { PlayerId, RawPlayer, RawPlayers } from 'types/domain/player.type';
import { DBError } from 'types/error.type';

export type DbPlayer = InferSelectModel<typeof schema.players>;
export type DbPlayerCreateInput = InferInsertModel<typeof schema.players>;

export type PlayerCreateInput = Omit<RawPlayer, 'id'> & { id: PlayerId };
export type PlayerCreateInputs = readonly PlayerCreateInput[];

export interface PlayerRepository {
  readonly findById: (id: PlayerId) => TE.TaskEither<DBError, RawPlayer>;
  readonly findAll: () => TE.TaskEither<DBError, RawPlayers>;
  readonly saveBatch: (playerInputs: PlayerCreateInputs) => TE.TaskEither<DBError, RawPlayers>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
