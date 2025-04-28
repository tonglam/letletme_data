import { InferInsertModel } from 'drizzle-orm';
import { InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/player-value';
import { RawPlayerValue, RawPlayerValues } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { DBError } from 'types/error.type';

export type DbPlayerValue = InferSelectModel<typeof schema.playerValues>;
export type DbPlayerValueCreateInput = InferInsertModel<typeof schema.playerValues>;

export type PlayerValueCreateInput = Omit<RawPlayerValue, 'id' | 'createdAt'>;
export type PlayerValueCreateInputs = readonly PlayerValueCreateInput[];

export interface PlayerValueRepository {
  readonly getLatestPlayerValuesByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DBError, ReadonlyArray<{ elementId: PlayerId; value: number }>>;
  readonly findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly findByElement: (elementId: PlayerId) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly findByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly savePlayerValueChangesByChangeDate: (
    playerValueInputs: PlayerValueCreateInputs,
  ) => TE.TaskEither<DBError, RawPlayerValues>;
}
