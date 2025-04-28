import { createInsertSchema } from 'drizzle-zod';
import { TaskEither } from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-info';
import { EntryInfo, EntryInfos, EntryId } from 'types/domain/entry-info.type';
import { DBError } from 'types/error.type';
import { z } from 'zod';

export type DbEntryInfo = typeof schema.entryInfos.$inferSelect;
export const DbEntryInfoCreateSchema = createInsertSchema(schema.entryInfos);
export type DbEntryInfoCreateInput = z.infer<typeof DbEntryInfoCreateSchema>;

// Define the update input type based on usage in repository
export type DbEntryInfoUpdateInput = Partial<
  Omit<DbEntryInfo, 'id' | 'createdAt'> & {
    lastEntryName?: string;
    lastOverallPoints?: number;
    lastOverallRank?: number;
    lastTeamValue?: number;
    usedEntryNames?: string[];
  }
>;

export interface EntryInfoRepository {
  findById(id: EntryId): TaskEither<DBError, EntryInfo>;
  findByIds(entryIds: ReadonlyArray<EntryId>): TaskEither<DBError, EntryInfos>;
  findAllEntryIds(): TaskEither<DBError, ReadonlyArray<EntryId>>;
  upsertEntryInfo(entryInfo: EntryInfo): TaskEither<DBError, EntryInfo>;
}
