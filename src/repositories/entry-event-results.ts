import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  entryEventResults,
  type DbEntryEventResult,
  type DbEntryEventResultInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import type { RawFPLEntryEventPicksResponse, RawFPLEntryHistoryCurrentItem } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  buildCoreHistoryConflictSet,
  buildCoreHistoryUpsertPlan,
  chunkCoreHistoryRows,
} from './entry-event-results-history';

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

export type EventPointsPayload = {
  elements: Array<{
    id: number;
    stats: { total_points: number };
  }>;
};

export type PreEntryBaselineUnit = {
  entryId: number;
  eventId: number;
};

const PRE_ENTRY_OVERALL_RANK = 2_147_483_647;

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

export const createEntryEventResultsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertCoreFromHistory: async (
      entryId: number,
      history: readonly RawFPLEntryHistoryCurrentItem[],
    ): Promise<{ upsertedEventIds: number[]; fallbackEventIds: number[] }> => {
      const plan = buildCoreHistoryUpsertPlan(entryId, history);

      try {
        const db = await getDbInstance();
        for (const rows of chunkCoreHistoryRows(plan.rows)) {
          await db
            .insert(entryEventResults)
            .values(rows)
            .onConflictDoUpdate({
              target: [entryEventResults.entryId, entryEventResults.eventId],
              set: buildCoreHistoryConflictSet(),
            });
        }

        logInfo('Upserted core entry event results from history', {
          entryId,
          upserted: plan.upsertedEventIds.length,
          fallback: plan.fallbackEventIds.length,
        });
        return {
          upsertedEventIds: plan.upsertedEventIds,
          fallbackEventIds: plan.fallbackEventIds,
        };
      } catch (error) {
        logError('Failed to upsert core entry event results from history', error, { entryId });
        throw new DatabaseError(
          'Failed to upsert core entry event results from history',
          'ENTRY_EVENT_RESULTS_HISTORY_UPSERT_ERROR',
          error as Error,
        );
      }
    },

    seedPreEntryBaselines: async (units: readonly PreEntryBaselineUnit[]): Promise<number> => {
      const uniqueUnits = [
        ...new Map(
          units
            .filter((unit) => unit.entryId > 0 && unit.eventId > 0)
            .map((unit) => [`${unit.entryId}:${unit.eventId}`, unit]),
        ).values(),
      ];
      if (uniqueUnits.length === 0) return 0;

      try {
        const db = await getDbInstance();
        let inserted = 0;
        for (let index = 0; index < uniqueUnits.length; index += 250) {
          const chunk = uniqueUnits.slice(index, index + 250);
          const rows = await db
            .insert(entryEventResults)
            .values(
              chunk.map((unit) => ({
                entryId: unit.entryId,
                eventId: unit.eventId,
                eventPoints: 0,
                eventTransfers: 0,
                eventTransfersCost: 0,
                eventNetPoints: 0,
                overallPoints: 0,
                overallRank: PRE_ENTRY_OVERALL_RANK,
              })),
            )
            .onConflictDoNothing({
              target: [entryEventResults.entryId, entryEventResults.eventId],
            })
            .returning({ id: entryEventResults.id });
          inserted += rows.length;
        }
        logInfo('Seeded pre-entry event result baselines', {
          requested: uniqueUnits.length,
          inserted,
        });
        return inserted;
      } catch (error) {
        logError('Failed to seed pre-entry event result baselines', error, {
          count: uniqueUnits.length,
        });
        throw new DatabaseError(
          'Failed to seed pre-entry event result baselines',
          'ENTRY_EVENT_RESULTS_BASELINE_UPSERT_ERROR',
          error as Error,
        );
      }
    },

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
      live: EventPointsPayload,
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
