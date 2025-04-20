import { PlayerValue, Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValues } from 'src/types/domain/player-value.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerValueCreateInput = Prisma.PlayerValueCreateInput;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PlayerValueCreateInput = Omit<PlayerValue, 'id' | 'createdAt'>;
export type PlayerValueCreateInputs = readonly PlayerValueCreateInput[];

export interface PlayerValueRepository {
  readonly findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, PlayerValues>;
  readonly findByElement: (element: number) => TE.TaskEither<DBError, PlayerValues>;
  readonly findByElements: (elements: number[]) => TE.TaskEither<DBError, PlayerValues>;
  readonly saveBatch: (
    playerValues: PlayerValueCreateInputs,
  ) => TE.TaskEither<DBError, PlayerValues>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
