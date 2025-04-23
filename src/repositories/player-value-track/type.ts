import {
  PlayerValueTrack,
  Prisma,
  PlayerValueTrack as PrismaPlayerValueTrackType,
} from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerValueTrackCreateInput = Prisma.PlayerValueTrackCreateInput;
export type PrismaPlayerValueTrack = PrismaPlayerValueTrackType;

export type PlayerValueTrackCreateInput = Omit<PlayerValueTrack, 'id' | 'createdAt'>;
export type PlayerValueTrackCreateInputs = readonly PlayerValueTrackCreateInput[];

export interface PlayerValueTrackRepository {
  readonly findByDate: (date: string) => TE.TaskEither<DBError, PlayerValueTracks>;
  readonly savePlayerValueTracksByDate: (
    playerValueTrackInputs: PlayerValueTrackCreateInputs,
  ) => TE.TaskEither<DBError, PlayerValueTracks>;
  readonly deleteByDate: (date: string) => TE.TaskEither<DBError, void>;
}
