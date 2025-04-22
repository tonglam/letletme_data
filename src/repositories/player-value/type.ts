import { PlayerValue, Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerValueCreateInput = Prisma.PlayerValueCreateInput;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PlayerValueCreateInput = Omit<PlayerValue, 'id' | 'createdAt'>;
export type PlayerValueCreateInputs = readonly PlayerValueCreateInput[];

export interface PlayerValueRepository {
  readonly getLatestPlayerValuesByElements: (
    elements: readonly number[],
  ) => TE.TaskEither<DBError, ReadonlyArray<{ element: number; value: number }>>;
  readonly findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly findByElement: (element: number) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly findByElements: (
    elements: readonly number[],
  ) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly savePlayerValueChangesByChangeDate: (
    playerValues: PlayerValueCreateInputs,
  ) => TE.TaskEither<DBError, SourcePlayerValues>;
  readonly deleteByChangeDate: (changeDate: string) => TE.TaskEither<DBError, void>;
}
