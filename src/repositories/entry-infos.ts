import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { entryInfos, type DbEntryInfo, type DbEntryInfoInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntrySummary } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

function uniqueNames(names: (string | null | undefined)[]): string[] {
  const result: string[] = [];
  for (const n of names) {
    if (!n) continue;
    if (!result.includes(n)) result.push(n);
  }
  return result;
}

export class EntryInfoRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findById(id: number): Promise<DbEntryInfo | null> {
    try {
      const db = await this.getDbInstance();
      const res = await db.select().from(entryInfos).where(eq(entryInfos.id, id));
      return res[0] || null;
    } catch (error) {
      logError('Failed to find entry info by id', error, { id });
      throw new DatabaseError(
        'Failed to retrieve entry info',
        'ENTRY_INFO_FIND_ERROR',
        error as Error,
      );
    }
  }

  async upsertFromSummary(summary: RawFPLEntrySummary): Promise<DbEntryInfo> {
    try {
      const db = await this.getDbInstance();
      const existing = await this.findById(summary.id);

      const currentEntryName = summary.name;
      const playerName = `${summary.player_first_name} ${summary.player_last_name}`.trim();

      // Always include the current entry name in history; also retain prior names
      const usedEntryNames = existing
        ? uniqueNames([
            ...(existing.usedEntryNames || []),
            currentEntryName,
            existing.entryName !== currentEntryName ? existing.entryName : null,
          ])
        : uniqueNames([currentEntryName]);

      // Determine current snapshot values from summary
      const currentTeamValue = summary.last_deadline_value ?? summary.value ?? null;
      const currentBank = summary.last_deadline_bank ?? summary.bank ?? null;
      const currentOverallPoints = summary.summary_overall_points ?? null;
      const currentOverallRank = summary.summary_overall_rank ?? null;

      // last_* fields: store previous record's current values; 0 if no previous
      const lastTeamValue = existing ? (existing.teamValue ?? 0) : 0;
      const lastBank = existing ? (existing.bank ?? 0) : 0;
      const lastOverallPoints = existing ? (existing.overallPoints ?? 0) : 0;
      const lastOverallRank = existing ? (existing.overallRank ?? 0) : 0;
      const lastEntryName = existing ? existing.entryName : null;

      const insert: DbEntryInfoInsert = {
        id: summary.id,
        entryName: currentEntryName,
        playerName,
        region: summary.player_region_name ?? null,
        startedEvent: summary.started_event ?? null,
        overallPoints: currentOverallPoints,
        overallRank: currentOverallRank,
        // Monetary fields are stored as tenths (raw ints from FPL summary last_deadline_*)
        bank: currentBank ?? existing?.bank ?? null,
        lastBank,
        teamValue: currentTeamValue ?? existing?.teamValue ?? null,
        totalTransfers: summary.last_deadline_total_transfers ?? null,
        lastEntryName,
        lastOverallPoints,
        lastOverallRank,
        lastTeamValue,
        usedEntryNames,
      };

      const result = await db
        .insert(entryInfos)
        .values(insert)
        .onConflictDoUpdate({ target: entryInfos.id, set: insert })
        .returning();

      const row = result[0];
      logInfo('Upserted entry info', { id: row.id, entryName: row.entryName });
      return row;
    } catch (error) {
      logError('Failed to upsert entry info', error, { id: summary.id });
      throw new DatabaseError(
        'Failed to upsert entry info',
        'ENTRY_INFO_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryInfoRepository = new EntryInfoRepository();
