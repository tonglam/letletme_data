import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

import { entryEventResults, type DbEntryEventResultInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryEventPicksResponse, RawFPLEventLiveResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EntryEventResultsRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async upsertFromPicksAndLive(
    entryId: number,
    eventId: number,
    picks: RawFPLEntryEventPicksResponse,
    live: RawFPLEventLiveResponse,
  ): Promise<void> {
    try {
      const db = await this.getDbInstance();

      const entryHistory = picks.entry_history;
      const activeChip = picks.active_chip ?? null;
      const captainPick = picks.picks.find((p) => p.is_captain) || null;
      const elementsPoints = new Map<number, number>();
      for (const el of live.elements) {
        elementsPoints.set(el.id, el.stats.total_points);
      }
      const captainPointsBase = captainPick ? elementsPoints.get(captainPick.element) ?? 0 : 0;
      const captainPoints = captainPick ? captainPointsBase * (captainPick.multiplier || 1) : null;

      const insert: DbEntryEventResultInsert = {
        entryId,
        eventId,
        eventPoints: entryHistory.points,
        eventTransfers: entryHistory.event_transfers,
        eventTransfersCost: entryHistory.event_transfers_cost,
        eventNetPoints: entryHistory.points - entryHistory.event_transfers_cost,
        eventBenchPoints: entryHistory.points_on_bench ?? null,
        eventAutoSubPoints: null,
        eventRank: entryHistory.rank ?? null,
        eventChip: activeChip ?? null,
        eventPlayedCaptain: captainPick ? captainPick.element : null,
        eventCaptainPoints: captainPoints,
        eventPicks: picks.picks as unknown as any,
        eventAutoSub: (picks as any).automatic_subs as unknown as any,
        overallPoints: entryHistory.total_points,
        overallRank: entryHistory.overall_rank ?? 0,
        teamValue: entryHistory.value ?? null,
        bank: entryHistory.bank ?? null,
      };

      await db
        .insert(entryEventResults)
        .values(insert)
        .onConflictDoUpdate({
          target: [entryEventResults.entryId, entryEventResults.eventId],
          set: {
            eventPoints: insert.eventPoints,
            eventTransfers: insert.eventTransfers,
            eventTransfersCost: insert.eventTransfersCost,
            eventNetPoints: insert.eventNetPoints,
            eventBenchPoints: insert.eventBenchPoints,
            eventAutoSubPoints: insert.eventAutoSubPoints,
            eventRank: insert.eventRank,
            eventChip: insert.eventChip,
            eventPlayedCaptain: insert.eventPlayedCaptain,
            eventCaptainPoints: insert.eventCaptainPoints,
            eventPicks: insert.eventPicks,
            eventAutoSub: insert.eventAutoSub,
            overallPoints: insert.overallPoints,
            overallRank: insert.overallRank,
            teamValue: insert.teamValue,
            bank: insert.bank,
          },
        });

      logInfo('Upserted entry event results', { entryId, eventId });
    } catch (error) {
      logError('Failed to upsert entry event results', error, { entryId, eventId });
      throw new DatabaseError(
        'Failed to upsert entry event results',
        'ENTRY_EVENT_RESULTS_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryEventResultsRepository = new EntryEventResultsRepository();

