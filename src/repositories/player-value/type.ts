import { PlayerValue, Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerValueCreateInput = Prisma.PlayerValueCreateInput;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PlayerValueCreateInput = Omit<PlayerValue, 'id' | 'createdAt'>;
export type PlayerValueCreateInputs = readonly PlayerValueCreateInput[];

export interface PlayerValueRepository {
  readonly findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly findByElement: (element: number) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly findByElements: (elements: number[]) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly saveBatch: (
    playerValues: PlayerValueCreateInputs,
  ) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly deleteByChangeDate: (changeDate: string) => TE.TaskEither<DBError, void>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
