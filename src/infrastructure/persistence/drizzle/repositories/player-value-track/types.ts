import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/player-value-track.schema';
import { PlayerValueTrack, PlayerValueTracks } from 'types/domain/player-value-track.type';
import { DBError } from 'types/error.type';

export type DbPlayerValueTrack = InferSelectModel<typeof schema.playerValueTracks>;
export type DbPlayerValueTrackCreateInput = InferInsertModel<typeof schema.playerValueTracks>;

export type PlayerValueTrackCreateInput = Omit<PlayerValueTrack, 'id' | 'createdAt'>;
export type PlayerValueTrackCreateInputs = readonly PlayerValueTrackCreateInput[];

export interface PlayerValueTrackRepository {
  readonly findByDate: (date: string) => TE.TaskEither<DBError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<DBError, PlayerValueTracks>;
}
