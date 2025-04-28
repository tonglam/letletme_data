import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/player-stat';
import { RawPlayerStat, RawPlayerStats } from 'types/domain/player-stat.type';
import { DBError } from 'types/error.type';

export type DbPlayerStat = InferSelectModel<typeof schema.playerStats>;
export type DbPlayerStatCreateInput = InferInsertModel<typeof schema.playerStats>;

export type PlayerStatCreateInput = RawPlayerStat;
export type PlayerStatCreateInputs = readonly PlayerStatCreateInput[];

export interface PlayerStatRepository {
  readonly findLatest: () => TE.TaskEither<DBError, RawPlayerStats>;
  readonly saveLatest: (
    playerStatInputs: PlayerStatCreateInputs,
  ) => TE.TaskEither<DBError, RawPlayerStats>;
  readonly deleteLatest: () => TE.TaskEither<DBError, void>;
}
