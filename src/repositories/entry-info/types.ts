import { Prisma, EntryInfo as PrismaEntryInfoType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { EntryId, EntryInfos } from 'src/types/domain/entry-info.type';
import { EntryInfo } from 'src/types/domain/entry-info.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryInfoCreateInput = Prisma.EntryInfoCreateInput;
export type PrismaEntryInfo = PrismaEntryInfoType;

export type EntryInfoCreateInput = Omit<EntryInfo, 'id'> & { id: EntryId };

export interface EntryInfoRepository {
  readonly findById: (id: EntryId) => TE.TaskEither<DBError, EntryInfo>;
  readonly findByEntryIds: (entryIds: ReadonlyArray<EntryId>) => TE.TaskEither<DBError, EntryInfos>;
  readonly upsertEntryInfo: (
    entryInfoInput: EntryInfoCreateInput,
  ) => TE.TaskEither<DBError, EntryInfo>;
  readonly deleteEntryInfo: (id: EntryId) => TE.TaskEither<DBError, void>;
}
