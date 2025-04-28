import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-history-info';
import { EntryHistoryInfo, EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { DBError } from 'types/error.type';

export type DbEntryHistoryInfo = InferSelectModel<typeof schema.entryHistoryInfos>;
export type DbEntryHistoryInfoCreateInput = InferInsertModel<typeof schema.entryHistoryInfos>;

export type EntryHistoryInfoCreateInput = EntryHistoryInfo;
export type EntryHistoryInfoCreateInputs = readonly EntryHistoryInfoCreateInput[];

export interface EntryHistoryInfoRepository {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DBError, EntryHistoryInfos>;
  readonly saveBatchByEntryId: (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ) => TE.TaskEither<DBError, EntryHistoryInfos>;
}
