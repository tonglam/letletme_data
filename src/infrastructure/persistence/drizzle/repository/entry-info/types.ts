import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-info.schema';
import { EntryInfo, EntryInfos, EntryId } from 'types/domain/entry-info.type';
import { DBError } from 'types/error.type';

export type DbEntryInfo = InferSelectModel<typeof schema.entryInfos>;
export type DbEntryInfoCreateInput = InferInsertModel<typeof schema.entryInfos>;
export type DbEntryInfoUpdateInput = Partial<Omit<DbEntryInfoCreateInput, 'id' | 'createdAt'>>;

export type EntryInfoCreateInput = EntryInfo;
export type EntryInfoCreateInputs = readonly EntryInfoCreateInput[];

export type EntryInfoUpdateInput = Partial<EntryInfo>;
export type EntryInfoUpdateInputs = readonly EntryInfoUpdateInput[];

export interface EntryInfoRepository {
  readonly findById: (id: EntryId) => TE.TaskEither<DBError, EntryInfo>;
  readonly findByIds: (ids: ReadonlyArray<EntryId>) => TE.TaskEither<DBError, EntryInfos>;
  readonly findAllIds: () => TE.TaskEither<DBError, ReadonlyArray<EntryId>>;
  readonly upsertEntryInfo: (entryInfo: EntryInfo) => TE.TaskEither<DBError, EntryInfo>;
}
