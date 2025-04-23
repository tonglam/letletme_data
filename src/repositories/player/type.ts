import { Prisma, Player as PrismaPlayerType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { PlayerId, RawPlayer, RawPlayers } from 'src/types/domain/player.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerCreateInput = Prisma.PlayerCreateInput;
export type PrismaPlayer = PrismaPlayerType;

export type PlayerCreateInput = Omit<RawPlayer, 'id'> & { id: PlayerId };
export type PlayerCreateInputs = readonly PlayerCreateInput[];

export interface PlayerRepository {
  readonly findById: (id: PlayerId) => TE.TaskEither<DBError, RawPlayer>;
  readonly findAll: () => TE.TaskEither<DBError, RawPlayers>;
  readonly saveBatch: (playerInputs: PlayerCreateInputs) => TE.TaskEither<DBError, RawPlayers>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
