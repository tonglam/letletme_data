import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { entryEventResults, type DbEntryEventResult } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import {
  hasCompleteEntryPickLiveCoverage,
  isCompleteEntryPicks,
  isEntryPicksPayloadForEvent,
  resolveScoringCaptainPick,
} from '../domain/entry-picks';
import type { RawFPLEntryEventPicksResponse, RawFPLEntryHistoryCurrentItem } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  buildCoreHistoryConflictSet,
  buildCoreHistoryUpsertPlan,
  chunkCoreHistoryRows,
} from './entry-event-results-history';

type AutoSubItem = RawFPLEntryEventPicksResponse['automatic_subs'][number];

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

function getAutoSubPoints(autoSubs: AutoSubItem[], elementsPoints: Map<number, number>): number {
  return autoSubs.reduce((total, sub) => {
    return total + (elementsPoints.get(sub.element_in) ?? 0);
  }, 0);
}

export function validateAutomaticSubs(
  entryId: number,
  eventId: number,
  picks: RawFPLEntryEventPicksResponse,
): AutoSubItem[] {
  const selectedElements = new Set(picks.picks.map((pick) => pick.element));
  const incomingElements = new Set<number>();
  const outgoingElements = new Set<number>();
  for (const substitution of picks.automatic_subs) {
    if (
      substitution.entry !== entryId ||
      substitution.event !== eventId ||
      substitution.element_in === substitution.element_out ||
      !selectedElements.has(substitution.element_in) ||
      !selectedElements.has(substitution.element_out) ||
      incomingElements.has(substitution.element_in) ||
      outgoingElements.has(substitution.element_out)
    ) {
      throw new Error(
        `Refusing invalid automatic substitutions for entry ${entryId}, event ${eventId}`,
      );
    }
    incomingElements.add(substitution.element_in);
    outgoingElements.add(substitution.element_out);
  }
  if ([...incomingElements].some((elementId) => outgoingElements.has(elementId))) {
    throw new Error(
      `Refusing invalid automatic substitutions for entry ${entryId}, event ${eventId}`,
    );
  }
  return picks.automatic_subs;
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

    findEntryIdsNeedingRichSync: async (
      entryIds: number[],
      eventId: number,
      freshAfter?: Date,
    ): Promise<number[]> => {
      const uniqueEntryIds = Array.from(new Set(entryIds));
      if (uniqueEntryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const syncedEntryIds = new Set<number>();
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const rows = await db
            .select({ entryId: entryEventResults.entryId })
            .from(entryEventResults)
            .where(
              and(
                eq(entryEventResults.eventId, eventId),
                inArray(entryEventResults.entryId, chunk),
                freshAfter
                  ? gte(entryEventResults.richSyncedAt, freshAfter)
                  : isNotNull(entryEventResults.richSyncedAt),
              ),
            );
          for (const row of rows) syncedEntryIds.add(row.entryId);
        }
        return uniqueEntryIds.filter((entryId) => !syncedEntryIds.has(entryId));
      } catch (error) {
        logError('Failed to audit rich entry event results', error, {
          eventId,
          freshAfter: freshAfter?.toISOString(),
        });
        throw new DatabaseError(
          'Failed to audit rich entry event results',
          'ENTRY_EVENT_RESULTS_RICH_AUDIT_ERROR',
          error as Error,
        );
      }
    },

    upsertFromPicksAndLive: async (
      entryId: number,
      eventId: number,
      picks: RawFPLEntryEventPicksResponse,
      live: EventPointsPayload,
      richSyncedAt: Date | string,
    ): Promise<void> => {
      if (!isEntryPicksPayloadForEvent(picks, eventId)) {
        throw new Error(
          `Refusing rich picks for an unexpected event for entry ${entryId}, event ${eventId}`,
        );
      }
      if (!isCompleteEntryPicks(picks.picks)) {
        throw new Error(`Refusing incomplete rich picks for entry ${entryId}, event ${eventId}`);
      }
      if (
        !hasCompleteEntryPickLiveCoverage(
          picks.picks,
          live.elements.map((element) => element.id),
        )
      ) {
        throw new Error(
          `Refusing incomplete event-live coverage for entry ${entryId}, event ${eventId}`,
        );
      }
      const autoSubs = validateAutomaticSubs(entryId, eventId, picks);
      try {
        const db = await getDbInstance();

        const entryHistory = picks.entry_history;
        const exactRichSyncedAt =
          richSyncedAt instanceof Date ? richSyncedAt.toISOString() : richSyncedAt;
        const richSyncedAtSql = sql`${exactRichSyncedAt}::timestamptz`;
        const activeChip = picks.active_chip ?? null;
        const captainPick = resolveScoringCaptainPick(picks.picks);
        const elementsPoints = new Map<number, number>();
        for (const el of live.elements) {
          elementsPoints.set(el.id, el.stats.total_points);
        }
        const autoSubPoints = getAutoSubPoints(autoSubs, elementsPoints);
        const captainPointsBase = captainPick ? (elementsPoints.get(captainPick.element) ?? 0) : 0;
        const captainPoints = captainPick ? captainPointsBase * captainPick.multiplier : null;
        const insert = {
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
          eventAutoSub: autoSubs as unknown,
          overallPoints: entryHistory.total_points,
          overallRank: entryHistory.overall_rank ?? 0,
          teamValue: entryHistory.value ?? null,
          bank: entryHistory.bank ?? null,
          richSyncedAt: richSyncedAtSql,
        };

        await db
          .insert(entryEventResults)
          .values(insert)
          .onConflictDoUpdate({
            target: [entryEventResults.entryId, entryEventResults.eventId],
            // Rich picks/live evidence is ordered by the timestamp captured
            // before the upstream reads. A slower, older attempt must not
            // replace a newer corrected result or move its checkpoint back.
            where: sql`
              ${entryEventResults.richSyncedAt} IS NULL
              OR ${entryEventResults.richSyncedAt} < ${richSyncedAtSql}
            `,
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
              richSyncedAt: richSyncedAtSql,
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
