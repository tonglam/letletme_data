import { Prisma, EntryHistoryInfo as PrismaEntryHistoryInfoType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { EntryHistoryInfo, EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryHistoryInfoCreateInput = Prisma.EntryHistoryInfoCreateInput;
export type PrismaEntryHistoryInfo = PrismaEntryHistoryInfoType;

export type EntryHistoryInfoCreateInput = EntryHistoryInfo;
export type EntryHistoryInfoCreateInputs = readonly EntryHistoryInfoCreateInput[];

export interface EntryHistoryInfoRepository {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DBError, EntryHistoryInfos>;
  readonly saveBatchByEntryId: (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ) => TE.TaskEither<DBError, EntryHistoryInfos>;
}
