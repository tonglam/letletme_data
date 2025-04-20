import { Prisma, Player as PrismaPlayerType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerCreateInput = Prisma.PlayerCreateInput;
export type PrismaPlayer = PrismaPlayerType;

export type PlayerCreateInput = Omit<Player, 'element'> & { element: PlayerId };
export type PlayerCreateInputs = readonly PlayerCreateInput[];

export interface PlayerRepository {
  readonly findById: (id: PlayerId) => TE.TaskEither<DBError, Player>;
  readonly findAll: () => TE.TaskEither<DBError, Players>;
  readonly saveBatch: (players: PlayerCreateInputs) => TE.TaskEither<DBError, Players>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
