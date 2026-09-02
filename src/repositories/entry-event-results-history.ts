import { sql } from 'drizzle-orm';

import {
  entryEventResultsInCompetition,
  type DbEntryEventResultInsert,
} from '../db/schemas/index.schema';
import { normalizeAuthoritativeUnrankedEventRank } from '../domain/entry-score';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryHistoryCurrentItem } from '../types';

export const CORE_HISTORY_BATCH_SIZE = 250;

export type CoreHistoryUpsertPlan = {
  rows: DbEntryEventResultInsert[];
  upsertedEventIds: number[];
  fallbackEventIds: number[];
};

export function buildCoreHistoryUpsertPlan(
  season: FplSeasonRef,
  entryId: number,
  history: readonly RawFPLEntryHistoryCurrentItem[],
): CoreHistoryUpsertPlan {
  const upsertable = history.filter(
    (item) =>
      Number.isInteger(item.event) &&
      typeof item.event_transfers === 'number' &&
      typeof item.event_transfers_cost === 'number',
  );
  const upsertedEventIds = upsertable.map((item) => item.event);
  const accepted = new Set(upsertedEventIds);

  return {
    rows: upsertable.map((item) => ({
      seasonId: season.seasonId,
      entryId,
      eventId: item.event,
      eventPoints: item.points,
      eventTransfers: item.event_transfers as number,
      eventTransfersCost: item.event_transfers_cost as number,
      eventNetPoints: item.points - (item.event_transfers_cost as number),
      eventBenchPoints: item.points_on_bench ?? null,
      eventRank: normalizeAuthoritativeUnrankedEventRank({
        rank: item.rank,
        overallRank: item.overall_rank,
        sourceTotalPoints: item.total_points,
      }),
      overallPoints: item.total_points,
      overallRank: item.overall_rank ?? 0,
      teamValue: item.value ?? null,
      bank: item.bank ?? null,
    })),
    upsertedEventIds,
    fallbackEventIds: history.map((item) => item.event).filter((eventId) => !accepted.has(eventId)),
  };
}

export function chunkCoreHistoryRows(
  rows: readonly DbEntryEventResultInsert[],
): DbEntryEventResultInsert[][] {
  const chunks: DbEntryEventResultInsert[][] = [];
  for (let index = 0; index < rows.length; index += CORE_HISTORY_BATCH_SIZE) {
    chunks.push(rows.slice(index, index + CORE_HISTORY_BATCH_SIZE));
  }
  return chunks;
}

export function buildCoreHistoryConflictSet() {
  const coreHistoryUnchanged = sql`
    ${entryEventResultsInCompetition.eventPoints} IS NOT DISTINCT FROM excluded.event_points
    AND ${entryEventResultsInCompetition.eventTransfers} IS NOT DISTINCT FROM excluded.event_transfers
    AND ${entryEventResultsInCompetition.eventTransfersCost} IS NOT DISTINCT FROM excluded.event_transfers_cost
    AND ${entryEventResultsInCompetition.eventNetPoints} IS NOT DISTINCT FROM excluded.event_net_points
    AND ${entryEventResultsInCompetition.eventBenchPoints} IS NOT DISTINCT FROM COALESCE(
      excluded.event_bench_points,
      ${entryEventResultsInCompetition.eventBenchPoints}
    )
    AND ${entryEventResultsInCompetition.eventRank} IS NOT DISTINCT FROM COALESCE(
      excluded.event_rank,
      ${entryEventResultsInCompetition.eventRank}
    )
    AND ${entryEventResultsInCompetition.overallPoints} IS NOT DISTINCT FROM excluded.overall_points
    AND ${entryEventResultsInCompetition.overallRank} IS NOT DISTINCT FROM CASE
      WHEN excluded.overall_rank = 0 THEN ${entryEventResultsInCompetition.overallRank}
      ELSE excluded.overall_rank
    END
    AND ${entryEventResultsInCompetition.teamValue} IS NOT DISTINCT FROM COALESCE(
      excluded.team_value,
      ${entryEventResultsInCompetition.teamValue}
    )
    AND ${entryEventResultsInCompetition.bank} IS NOT DISTINCT FROM COALESCE(
      excluded.bank,
      ${entryEventResultsInCompetition.bank}
    )
  `;
  return {
    eventPoints: sql`excluded.event_points`,
    eventTransfers: sql`excluded.event_transfers`,
    eventTransfersCost: sql`excluded.event_transfers_cost`,
    eventNetPoints: sql`excluded.event_net_points`,
    eventBenchPoints: sql`COALESCE(
      excluded.event_bench_points,
      ${entryEventResultsInCompetition.eventBenchPoints}
    )`,
    eventRank: sql`COALESCE(excluded.event_rank, ${entryEventResultsInCompetition.eventRank})`,
    overallPoints: sql`excluded.overall_points`,
    overallRank: sql`CASE
      WHEN excluded.overall_rank = 0 THEN ${entryEventResultsInCompetition.overallRank}
      ELSE excluded.overall_rank
    END`,
    teamValue: sql`COALESCE(excluded.team_value, ${entryEventResultsInCompetition.teamValue})`,
    bank: sql`COALESCE(excluded.bank, ${entryEventResultsInCompetition.bank})`,
    updatedAt: sql`CASE
      WHEN ${coreHistoryUnchanged}
        THEN ${entryEventResultsInCompetition.updatedAt}
      ELSE clock_timestamp()
    END`,
  };
}
