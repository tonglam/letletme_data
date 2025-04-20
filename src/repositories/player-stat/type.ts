import { PlayerStat, Prisma, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStats } from 'src/types/domain/player-stat.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerStatCreateInput = Prisma.PlayerStatCreateInput;
export type PrismaPlayerStat = PrismaPlayerStatType;

export type PlayerStatCreateInput = Omit<PlayerStat, 'id' | 'createdAt' | 'updatedAt'>;
export type PlayerStatCreateInputs = readonly PlayerStatCreateInput[];

export interface PlayerStatRepository {
  readonly findByElement: (element: number) => TE.TaskEither<DBError, PlayerStats>;
  readonly findByElements: (elements: number[]) => TE.TaskEither<DBError, PlayerStats>;
  readonly findByEvent: (event: number) => TE.TaskEither<DBError, PlayerStats>;
  readonly findAll: () => TE.TaskEither<DBError, PlayerStats>;
  readonly saveBatch: (playerStats: PlayerStats) => TE.TaskEither<DBError, PlayerStats>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
