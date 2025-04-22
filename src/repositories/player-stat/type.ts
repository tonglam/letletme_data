import { PlayerStat, Prisma, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { SourcePlayerStats } from 'src/types/domain/player-stat.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerStatCreateInput = Prisma.PlayerStatCreateInput;
export type PrismaPlayerStat = PrismaPlayerStatType;

export type PlayerStatCreateInput = Omit<PlayerStat, 'id' | 'createdAt' | 'updatedAt'>;
export type PlayerStatCreateInputs = readonly PlayerStatCreateInput[];

export interface PlayerStatRepository {
  readonly findLatest: () => TE.TaskEither<DBError, SourcePlayerStats>;
  readonly saveLatest: (
    playerStats: PlayerStatCreateInputs,
  ) => TE.TaskEither<DBError, SourcePlayerStats>;
  readonly deleteLatest: () => TE.TaskEither<DBError, void>;
}
