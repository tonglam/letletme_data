import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventResults,
  type DbEntryEventResult,
  type DbEntryEventResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import type { RawFPLEntryEventPicksResponse, RawFPLEventLiveResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

type AutoSubItem = {
  element_in?: number | null;
  elementIn?: number | null;
};

type EntryEventTotalsRow = {
  entryId: number;
  totalPoints: number;
  totalTransfersCost: number;
  totalNetPoints: number;
};

function normalizeAutoSubs(raw: unknown): AutoSubItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw as AutoSubItem[];
}

function getAutoSubPoints(autoSubs: AutoSubItem[], elementsPoints: Map<number, number>): number {
  return autoSubs.reduce((total, sub) => {
    const elementId = sub.element_in ?? sub.elementIn;
    if (!elementId) {
      return total;
    }

    return total + (elementsPoints.get(elementId) ?? 0);
  }, 0);
}

export const createEntryEventResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    aggregateTotalsByEntry: async (
      entryIds: number[],
      startEventId: number,
      endEventId: number,
    ): Promise<EntryEventTotalsRow[]> => {
      if (entryIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const chunks: number[][] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          chunks.push(uniqueEntryIds.slice(index, index + 1000));
        }

        const rows: EntryEventTotalsRow[] = [];
        for (const chunk of chunks) {
          const chunkRows = await db
            .select({
              entryId: entryEventResults.entryId,
              totalPoints: sql<number>`COALESCE(SUM(${entryEventResults.eventPoints}), 0)::int`,
              totalTransfersCost: sql<number>`COALESCE(SUM(${entryEventResults.eventTransfersCost}), 0)::int`,
              totalNetPoints: sql<number>`COALESCE(SUM(${entryEventResults.eventNetPoints}), 0)::int`,
            })
            .from(entryEventResults)
            .where(
              and(
                inArray(entryEventResults.entryId, chunk),
                gte(entryEventResults.eventId, startEventId),
                lte(entryEventResults.eventId, endEventId),
              ),
            )
            .groupBy(entryEventResults.entryId);

          rows.push(...chunkRows);
        }

        logInfo('Aggregated entry event results totals', { count: rows.length });
        return rows;
      } catch (error) {
        logError('Failed to aggregate entry event results totals', error);
        throw new DatabaseError(
          'Failed to aggregate entry event results totals',
          'ENTRY_EVENT_RESULTS_AGGREGATE_ERROR',
          error as Error,
        );
      }
    },

    findByEventAndEntryIds: async (
      eventId: number,
      entryIds: number[],
    ): Promise<DbEntryEventResult[]> => {
      if (entryIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const chunks: number[][] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          chunks.push(uniqueEntryIds.slice(index, index + 1000));
        }

        const results: DbEntryEventResult[] = [];
        for (const chunk of chunks) {
          const rows = await db
            .select()
            .from(entryEventResults)
            .where(
              and(
                eq(entryEventResults.eventId, eventId),
                inArray(entryEventResults.entryId, chunk),
              ),
            );
          results.push(...rows);
        }

        logInfo('Retrieved entry event results', { eventId, count: results.length });
        return results;
      } catch (error) {
        logError('Failed to retrieve entry event results', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve entry event results',
          'ENTRY_EVENT_RESULTS_FIND_ERROR',
          error as Error,
        );
      }
    },

    upsertFromPicksAndLive: async (
      entryId: number,
      eventId: number,
      picks: RawFPLEntryEventPicksResponse,
      live: RawFPLEventLiveResponse,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();

        const entryHistory = picks.entry_history;
        const activeChip = picks.active_chip ?? null;
        const captainPick = picks.picks.find((p) => p.is_captain) || null;
        const elementsPoints = new Map<number, number>();
        for (const el of live.elements) {
          elementsPoints.set(el.id, el.stats.total_points);
        }
        const autoSubs = normalizeAutoSubs(picks.automatic_subs);
        const autoSubPoints = getAutoSubPoints(autoSubs, elementsPoints);
        const captainPointsBase = captainPick ? (elementsPoints.get(captainPick.element) ?? 0) : 0;
        const captainPoints = captainPick
          ? captainPointsBase * (captainPick.multiplier || 1)
          : null;

        const insert: DbEntryEventResultInsert = {
          entryId,
          eventId,
          eventPoints: entryHistory.points,
          eventTransfers: entryHistory.event_transfers,
          eventTransfersCost: entryHistory.event_transfers_cost,
          eventNetPoints: entryHistory.points - entryHistory.event_transfers_cost,
          eventBenchPoints: entryHistory.points_on_bench ?? null,
          eventAutoSubPoints: autoSubPoints,
          eventRank: entryHistory.rank ?? null,
          eventChip: toNullableDbChip(activeChip),
          eventPlayedCaptain: captainPick ? captainPick.element : null,
          eventCaptainPoints: captainPoints,
          eventPicks: picks.picks as unknown,
          eventAutoSub: picks.automatic_subs as unknown,
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
              updatedAt: new Date(),
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
    },
  };
};

export const entryEventResultsRepository = createEntryEventResultsRepository();
