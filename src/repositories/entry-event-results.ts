import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import {
  entryEventPicksInCompetition,
  entryEventResultsInCompetition,
  type DbEntryEventResult,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toNullableDbChip } from '../domain/chips';
import { deriveEventLiveManagerScore } from '../domain/event-live-manager-score';
import {
  hasCompleteEntryPickLiveCoverage,
  isCompleteEntryPicks,
  isEntryPicksPayloadForEvent,
  resolveScoringCaptainPick,
} from '../domain/entry-picks';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryEventPicksResponse, RawFPLEntryHistoryCurrentItem } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  buildCoreHistoryConflictSet,
  buildCoreHistoryUpsertPlan,
  chunkCoreHistoryRows,
} from './entry-event-results-history';

type AutoSubItem = RawFPLEntryEventPicksResponse['automatic_subs'][number];
type ResultStorage = typeof entryEventResultsInCompetition.$inferSelect;
type PickStorage = typeof entryEventPicksInCompetition.$inferSelect;

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
  return autoSubs.reduce((total, sub) => total + (elementsPoints.get(sub.element_in) ?? 0), 0);
}

function hydrateResult(row: ResultStorage, picks: readonly PickStorage[]): DbEntryEventResult {
  return {
    ...row,
    id: row.sourceResultId,
    eventPlayedCaptain: row.playedCaptainElementId,
    eventCaptainPoints: row.captainPoints,
    eventPicks: picks.map((pick) => ({
      element: pick.elementId,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.isCaptain,
      is_vice_captain: pick.isViceCaptain,
    })),
    eventAutoSub: row.automaticSubstitutions,
  };
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
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    upsertCoreFromHistory: async (
      season: FplSeasonRef,
      entryId: number,
      history: readonly RawFPLEntryHistoryCurrentItem[],
    ): Promise<{ upsertedEventIds: number[]; fallbackEventIds: number[] }> => {
      const plan = buildCoreHistoryUpsertPlan(season, entryId, history);

      try {
        const db = await getDbInstance();
        for (const rows of chunkCoreHistoryRows(plan.rows)) {
          await db
            .insert(entryEventResultsInCompetition)
            .values(rows)
            .onConflictDoUpdate({
              target: [
                entryEventResultsInCompetition.seasonId,
                entryEventResultsInCompetition.entryId,
                entryEventResultsInCompetition.eventId,
              ],
              set: buildCoreHistoryConflictSet(),
            });
        }

        logInfo('Upserted core entry event results from history', {
          season: season.seasonCode,
          entryId,
          upserted: plan.upsertedEventIds.length,
          fallback: plan.fallbackEventIds.length,
        });
        return {
          upsertedEventIds: plan.upsertedEventIds,
          fallbackEventIds: plan.fallbackEventIds,
        };
      } catch (error) {
        logError('Failed to upsert core entry event results from history', error, {
          season: season.seasonCode,
          entryId,
        });
        throw new DatabaseError(
          'Failed to upsert core entry event results from history',
          'ENTRY_EVENT_RESULTS_HISTORY_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    seedPreEntryBaselines: async (
      season: FplSeasonRef,
      units: readonly PreEntryBaselineUnit[],
    ): Promise<number> => {
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
            .insert(entryEventResultsInCompetition)
            .values(
              chunk.map((unit) => ({
                seasonId: season.seasonId,
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
              target: [
                entryEventResultsInCompetition.seasonId,
                entryEventResultsInCompetition.entryId,
                entryEventResultsInCompetition.eventId,
              ],
            })
            .returning({ sourceResultId: entryEventResultsInCompetition.sourceResultId });
          inserted += rows.length;
        }
        logInfo('Seeded pre-entry event result baselines', {
          season: season.seasonCode,
          requested: uniqueUnits.length,
          inserted,
        });
        return inserted;
      } catch (error) {
        logError('Failed to seed pre-entry event result baselines', error, {
          season: season.seasonCode,
          count: uniqueUnits.length,
        });
        throw new DatabaseError(
          'Failed to seed pre-entry event result baselines',
          'ENTRY_EVENT_RESULTS_BASELINE_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    aggregateTotalsByEntry: async (
      season: FplSeasonRef,
      entryIds: number[],
      startEventId: number,
      endEventId: number,
    ): Promise<EntryEventTotalsRow[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const rows: EntryEventTotalsRow[] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const chunkRows = await db
            .select({
              entryId: entryEventResultsInCompetition.entryId,
              totalPoints: sql<number>`COALESCE(SUM(${entryEventResultsInCompetition.eventPoints}), 0)::int`,
              totalTransfersCost: sql<number>`COALESCE(SUM(${entryEventResultsInCompetition.eventTransfersCost}), 0)::int`,
              totalNetPoints: sql<number>`COALESCE(SUM(${entryEventResultsInCompetition.eventNetPoints}), 0)::int`,
            })
            .from(entryEventResultsInCompetition)
            .where(
              and(
                eq(entryEventResultsInCompetition.seasonId, season.seasonId),
                inArray(entryEventResultsInCompetition.entryId, chunk),
                gte(entryEventResultsInCompetition.eventId, startEventId),
                lte(entryEventResultsInCompetition.eventId, endEventId),
              ),
            )
            .groupBy(entryEventResultsInCompetition.entryId);
          rows.push(...chunkRows);
        }
        return rows;
      } catch (error) {
        logError('Failed to aggregate entry event results totals', error, {
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to aggregate entry event results totals',
          'ENTRY_EVENT_RESULTS_AGGREGATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByEventAndEntryIds: async (
      season: FplSeasonRef,
      eventId: number,
      entryIds: number[],
    ): Promise<DbEntryEventResult[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const results: DbEntryEventResult[] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const [resultRows, pickRows] = await Promise.all([
            db
              .select()
              .from(entryEventResultsInCompetition)
              .where(
                and(
                  eq(entryEventResultsInCompetition.seasonId, season.seasonId),
                  eq(entryEventResultsInCompetition.eventId, eventId),
                  inArray(entryEventResultsInCompetition.entryId, chunk),
                ),
              ),
            db
              .select()
              .from(entryEventPicksInCompetition)
              .where(
                and(
                  eq(entryEventPicksInCompetition.seasonId, season.seasonId),
                  eq(entryEventPicksInCompetition.eventId, eventId),
                  inArray(entryEventPicksInCompetition.entryId, chunk),
                ),
              )
              .orderBy(
                asc(entryEventPicksInCompetition.entryId),
                asc(entryEventPicksInCompetition.position),
              ),
          ]);
          const picksByEntry = new Map<number, PickStorage[]>();
          for (const pick of pickRows) {
            const entryPicks = picksByEntry.get(pick.entryId) ?? [];
            entryPicks.push(pick);
            picksByEntry.set(pick.entryId, entryPicks);
          }
          results.push(
            ...resultRows.map((row) => hydrateResult(row, picksByEntry.get(row.entryId) ?? [])),
          );
        }
        return results;
      } catch (error) {
        logError('Failed to retrieve entry event results', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve entry event results',
          'ENTRY_EVENT_RESULTS_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findEntryIdsNeedingRichSync: async (
      season: FplSeasonRef,
      entryIds: number[],
      eventId: number,
      freshAfter?: Date | string,
    ): Promise<number[]> => {
      const uniqueEntryIds = Array.from(new Set(entryIds));
      if (uniqueEntryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const syncedEntryIds = new Set<number>();
        const threshold =
          freshAfter instanceof Date ? freshAfter : freshAfter ? new Date(freshAfter) : undefined;
        if (threshold && !Number.isFinite(threshold.getTime())) {
          throw new Error('A valid rich-sync freshness timestamp is required');
        }
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const rows = await db
            .select({ entryId: entryEventResultsInCompetition.entryId })
            .from(entryEventResultsInCompetition)
            .where(
              and(
                eq(entryEventResultsInCompetition.seasonId, season.seasonId),
                eq(entryEventResultsInCompetition.eventId, eventId),
                inArray(entryEventResultsInCompetition.entryId, chunk),
                threshold
                  ? gte(entryEventResultsInCompetition.richSyncedAt, threshold)
                  : isNotNull(entryEventResultsInCompetition.richSyncedAt),
              ),
            );
          for (const row of rows) syncedEntryIds.add(row.entryId);
        }
        return uniqueEntryIds.filter((entryId) => !syncedEntryIds.has(entryId));
      } catch (error) {
        logError('Failed to audit rich entry event results', error, {
          season: season.seasonCode,
          eventId,
          freshAfter: freshAfter instanceof Date ? freshAfter.toISOString() : freshAfter,
        });
        throw new DatabaseError(
          'Failed to audit rich entry event results',
          'ENTRY_EVENT_RESULTS_RICH_AUDIT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertFromPicksAndLive: async (
      season: FplSeasonRef,
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
        const exactRichSyncedAt =
          richSyncedAt instanceof Date ? richSyncedAt : new Date(richSyncedAt);
        if (!Number.isFinite(exactRichSyncedAt.getTime())) {
          throw new Error('A valid rich-sync source timestamp is required');
        }
        const richSyncedAtIso = exactRichSyncedAt.toISOString();

        const entryHistory = picks.entry_history;
        const captainPick = resolveScoringCaptainPick(picks.picks);
        const elementsPoints = new Map<number, number>();
        for (const element of live.elements) {
          elementsPoints.set(element.id, element.stats.total_points);
        }
        const eventLiveScore = deriveEventLiveManagerScore(
          entryId,
          picks.picks.map((pick) => ({
            entryId,
            position: pick.position,
            elementId: pick.element,
            multiplier: pick.multiplier,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            transfersCost: pick.position === 1 ? picks.entry_history.event_transfers_cost : null,
            sourceUpdatedAt: exactRichSyncedAt,
          })),
          elementsPoints,
        );
        if (!eventLiveScore) {
          throw new Error(
            `Refusing untraceable event-live manager score for entry ${entryId}, event ${eventId}`,
          );
        }
        const captainPointsBase = captainPick ? (elementsPoints.get(captainPick.element) ?? 0) : 0;
        const previousOverallPoints =
          picks.entry_history.total_points -
          (picks.entry_history.points - picks.entry_history.event_transfers_cost);
        const benchPoints = picks.picks
          .filter((pick) => pick.position > 11)
          .reduce((total, pick) => total + (elementsPoints.get(pick.element) ?? 0), 0);
        const insert = {
          seasonId: season.seasonId,
          entryId,
          eventId,
          eventPoints: eventLiveScore.eventPoints,
          eventTransfers: entryHistory.event_transfers,
          eventTransfersCost: entryHistory.event_transfers_cost,
          eventNetPoints: eventLiveScore.netEventPoints,
          eventBenchPoints: benchPoints,
          eventAutoSubPoints: getAutoSubPoints(autoSubs, elementsPoints),
          eventRank: entryHistory.rank ?? null,
          eventChip: toNullableDbChip(picks.active_chip),
          playedCaptainElementId: captainPick ? captainPick.element : null,
          captainPoints: captainPick ? captainPointsBase * captainPick.multiplier : null,
          automaticSubstitutions: autoSubs,
          overallPoints: previousOverallPoints + eventLiveScore.netEventPoints,
          overallRank: entryHistory.overall_rank ?? 0,
          teamValue: entryHistory.value ?? null,
          bank: entryHistory.bank ?? null,
          richSyncedAt: exactRichSyncedAt,
        };

        await db
          .insert(entryEventResultsInCompetition)
          .values(insert)
          .onConflictDoUpdate({
            target: [
              entryEventResultsInCompetition.seasonId,
              entryEventResultsInCompetition.entryId,
              entryEventResultsInCompetition.eventId,
            ],
            where: sql`
              ${entryEventResultsInCompetition.richSyncedAt} IS NULL
              OR ${entryEventResultsInCompetition.richSyncedAt} < ${richSyncedAtIso}::timestamptz
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
              playedCaptainElementId: insert.playedCaptainElementId,
              captainPoints: insert.captainPoints,
              automaticSubstitutions: insert.automaticSubstitutions,
              overallPoints: insert.overallPoints,
              overallRank: insert.overallRank,
              teamValue: insert.teamValue,
              bank: insert.bank,
              richSyncedAt: exactRichSyncedAt,
              updatedAt: new Date(),
            },
          });
        logInfo('Upserted entry event results', {
          season: season.seasonCode,
          entryId,
          eventId,
        });
      } catch (error) {
        logError('Failed to upsert entry event results', error, {
          season: season.seasonCode,
          entryId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to upsert entry event results',
          'ENTRY_EVENT_RESULTS_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryEventResultsRepository = createEntryEventResultsRepository();
