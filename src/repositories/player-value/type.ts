import { Prisma, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { RawPlayerValue, RawPlayerValues } from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';
import { DBError } from 'src/types/error.type';

export type PrismaPlayerValueCreateInput = Prisma.PlayerValueCreateInput;
export type PrismaPlayerValue = PrismaPlayerValueType;

export type PlayerValueCreateInput = Omit<RawPlayerValue, 'id' | 'createdAt'>;
export type PlayerValueCreateInputs = readonly PlayerValueCreateInput[];

export interface PlayerValueRepository {
  readonly getLatestPlayerValuesByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DBError, ReadonlyArray<{ elementId: PlayerId; value: number }>>;
  readonly findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly findByElement: (elementId: PlayerId) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly findByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly savePlayerValueChangesByChangeDate: (
    playerValueInputs: PlayerValueCreateInputs,
  ) => TE.TaskEither<DBError, RawPlayerValues>;
  readonly deleteByChangeDate: (changeDate: string) => TE.TaskEither<DBError, void>;
}
