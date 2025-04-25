import { Prisma, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { RawPlayerStat, RawPlayerStats } from 'src/types/domain/player-stat.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerStatCreateInput = Prisma.PlayerStatCreateInput;
export type PrismaPlayerStat = PrismaPlayerStatType;

export type PlayerStatCreateInput = RawPlayerStat;
export type PlayerStatCreateInputs = readonly PlayerStatCreateInput[];

export interface PlayerStatRepository {
  readonly findLatest: () => TE.TaskEither<DBError, RawPlayerStats>;
  readonly saveLatest: (
    playerStatInputs: PlayerStatCreateInputs,
  ) => TE.TaskEither<DBError, RawPlayerStats>;
  readonly deleteLatest: () => TE.TaskEither<DBError, void>;
}
