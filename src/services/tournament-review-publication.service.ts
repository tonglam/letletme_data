import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import { getDbClient, withDatabaseTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { GroupMode, KnockoutMode, LeagueType } from '../domain/tournament';
import { postgresJsonbCanonicalJson } from '../utils/content-hash';
import { logError, logInfo } from '../utils/logger';

export const TOURNAMENT_REVIEW_SCHEMA_VERSION = 'my-tournament-review-v2';
export const TOURNAMENT_REVIEW_METRIC_VERSION = 'descriptive-v1';

export type TournamentReviewFormat = 'POINTS' | 'H2H' | 'KNOCKOUT';
export type TournamentReviewObligationState =
  | 'PENDING'
  | 'WAITING_SOURCE'
  | 'PROCESSING'
  | 'READY'
  | 'DEGRADED';

export type TournamentReviewFormatInput = Readonly<{
  groupMode: GroupMode | string | null;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  knockoutMode: KnockoutMode | string | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
}>;

export type TournamentReviewPublicationResult = Readonly<{
  seasonId: number;
  tournamentId: number;
  eventId: number;
  revision: number;
  format: TournamentReviewFormat;
  contentSha256: string;
  rowCount: number;
  expectedSubjectCount: number;
  readySubjectCount: number;
  notApplicableSubjectCount: number;
  publishedAt: Date;
  state: 'PUBLISHED' | 'REUSED';
}>;

type JsonRecord = Record<string, unknown>;

type TournamentRow = {
  tournament_id: number;
  tournament_name: string;
  creator: string;
  admin_entry_id: number;
  league_id: number;
  league_type: LeagueType | string;
  total_team_num: number;
  group_mode: GroupMode | string | null;
  group_started_event_id: number | null;
  group_ended_event_id: number | null;
  knockout_mode: KnockoutMode | string | null;
  knockout_started_event_id: number | null;
  knockout_ended_event_id: number | null;
  setup_status: string;
  setup_finished_at: Date | string | null;
  standings_ready_at: Date | string | null;
};

type EventRow = {
  event_id: number;
  event_name: string;
  finished: boolean;
  data_checked: boolean;
  data_checked_at: Date | string | null;
};

export class TournamentReviewSourceNotReadyError extends Error {
  readonly code = 'TOURNAMENT_REVIEW_SOURCE_NOT_READY';

  constructor(message: string) {
    super(message);
    this.name = 'TournamentReviewSourceNotReadyError';
  }
}

export class TournamentReviewPublicationError extends Error {
  readonly code = 'TOURNAMENT_REVIEW_PUBLICATION_FAILED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TournamentReviewPublicationError';
  }
}

function positive(value: number | null | undefined): number | null {
  const normalized = value ?? null;
  return normalized !== null && Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function integer(value: unknown, fallback = 0): number {
  return integerOrNull(value) ?? fallback;
}

function dateIso(value: Date | string | null | undefined): string | null {
  return asDate(value)?.toISOString() ?? null;
}

function sortRank(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Resolve the one review format that owns a finalized event. Knockout wins
 * at the boundary so a tournament never exposes the group and bracket views
 * for the same gameweek. */
export function resolveTournamentReviewFormat(
  input: TournamentReviewFormatInput,
  eventId: number,
): TournamentReviewFormat | null {
  const knockoutStart = positive(input.knockoutStartedEventId);
  const knockoutEnd = positive(input.knockoutEndedEventId);
  if (
    input.knockoutMode &&
    input.knockoutMode !== 'no_knockout' &&
    knockoutStart !== null &&
    eventId >= knockoutStart &&
    (knockoutEnd === null || eventId <= knockoutEnd)
  ) {
    return 'KNOCKOUT';
  }

  const groupStart = positive(input.groupStartedEventId);
  const groupEnd = positive(input.groupEndedEventId);
  if (groupStart !== null && eventId >= groupStart && (groupEnd === null || eventId <= groupEnd)) {
    if (input.groupMode === 'points_races') return 'POINTS';
    if (input.groupMode === 'battle_races') return 'H2H';
  }
  return null;
}

/** Delays after a failed attempt. Source rechecks do not consume execution
 * attempts; after the bounded fast path the obligation enters DEGRADED and
 * is repaired on the 15-minute cadence until its 24-hour horizon. */
export function tournamentReviewRetryDelayMs(
  kind: 'source' | 'execution',
  failureNumber: number,
): number | null {
  if (!Number.isInteger(failureNumber) || failureNumber < 1) return null;
  const schedule = kind === 'source' ? [60_000, 180_000, 600_000] : [60_000, 300_000, 900_000];
  return schedule[failureNumber - 1] ?? null;
}

function reviewFingerprint(code: string, bucket: string): string {
  return createHash('sha256')
    .update(`${TOURNAMENT_REVIEW_SCHEMA_VERSION}:${code}:${bucket}`, 'utf8')
    .digest('hex');
}

function sourceSpan(timestamps: Array<Date | string | null | undefined>): {
  sourceMin: Date;
  sourceMax: Date;
} {
  const dates = timestamps.map(asDate).filter((date): date is Date => date !== null);
  if (dates.length === 0)
    throw new TournamentReviewSourceNotReadyError('review source provenance is missing');
  const sourceMin = dates.reduce(
    (min, date) => (date.getTime() < min.getTime() ? date : min),
    dates[0],
  );
  const sourceMax = dates.reduce(
    (max, date) => (date.getTime() > max.getTime() ? date : max),
    dates[0],
  );
  return { sourceMin, sourceMax };
}

function eventReviewPayload(
  tournament: TournamentRow,
  event: EventRow,
  format: TournamentReviewFormat,
  freshness: { sourceMin: Date; sourceMax: Date },
): JsonRecord {
  return {
    schemaVersion: TOURNAMENT_REVIEW_SCHEMA_VERSION,
    metricVersion: TOURNAMENT_REVIEW_METRIC_VERSION,
    format,
    tournament: {
      id: tournament.tournament_id,
      name: tournament.tournament_name,
      creator: tournament.creator,
      adminEntryId: tournament.admin_entry_id,
      leagueId: tournament.league_id,
      leagueType: tournament.league_type,
      totalTeamNum: tournament.total_team_num,
    },
    event: {
      id: event.event_id,
      name: event.event_name,
      finished: event.finished,
      dataCheckedAt: dateIso(event.data_checked_at),
    },
    freshness: {
      sourceMinCheckedAt: freshness.sourceMin.toISOString(),
      sourceMaxCheckedAt: freshness.sourceMax.toISOString(),
    },
  };
}

type PointsSourceRow = {
  entry_id: number;
  entry_name: string;
  player_name: string;
  started_event: number | null;
  entry_updated_at: Date | string;
  roster_created_at: Date | string;
  event_points: number | null;
  event_cost: number | null;
  event_net_points: number | null;
  event_rank: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  rich_synced_at: Date | string | null;
  group_id: number | null;
  event_group_rank: number | null;
  group_event_net_points: number | null;
  group_updated_at: Date | string | null;
  season_gross_points: number | null;
  season_net_points: number | null;
  season_expected_event_count: number | null;
  season_gross_result_count: number | null;
  season_net_result_count: number | null;
  history_source_min_checked_at: Date | string | null;
  history_source_max_checked_at: Date | string | null;
  previous_group_rank: number | null;
};

async function buildPointsPayload(
  tx: postgres.TransactionSql,
  seasonId: number,
  tournament: TournamentRow,
  event: EventRow,
  header: JsonRecord,
): Promise<{
  payload: JsonRecord;
  rowCount: number;
  expectedSubjectCount: number;
  readySubjectCount: number;
  notApplicableSubjectCount: number;
  sourceTimes: Array<Date | string | null>;
}> {
  const rows = await tx<PointsSourceRow[]>`
    SELECT roster.entry_id,
           entry.entry_name,
           entry.player_name,
           entry.started_event,
           entry.updated_at AS entry_updated_at,
           roster.created_at AS roster_created_at,
           result.event_points,
           result.event_transfers_cost AS event_cost,
           result.event_net_points,
           result.event_rank,
           result.overall_points,
           result.overall_rank,
           result.rich_synced_at,
           group_result.group_id,
           group_result.event_group_rank,
           group_result.event_net_points AS group_event_net_points,
           group_result.updated_at AS group_updated_at,
           (
             SELECT COALESCE(sum(history.event_points), 0)::integer
             FROM competition.entry_event_results history
             JOIN fpl.events history_event
               ON history_event.season_id = history.season_id
              AND history_event.event_id = history.event_id
             WHERE history.season_id = roster.season_id
               AND history.entry_id = roster.entry_id
               AND history.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
           ) AS season_gross_points,
           (
             SELECT count(*)::integer
             FROM fpl.events history_event
             WHERE history_event.season_id = roster.season_id
               AND history_event.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history_event.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
           ) AS season_expected_event_count,
           (
             SELECT count(*)::integer
             FROM competition.entry_event_results history
             JOIN fpl.events history_event
               ON history_event.season_id = history.season_id
              AND history_event.event_id = history.event_id
             WHERE history.season_id = roster.season_id
               AND history.entry_id = roster.entry_id
               AND history.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
               AND history.event_points IS NOT NULL
               AND history.rich_synced_at >= history_event.data_checked_at
           ) AS season_gross_result_count,
           (
             SELECT previous.event_group_rank
             FROM competition.tournament_points_group_results previous
             WHERE previous.season_id = roster.season_id
               AND previous.tournament_id = roster.tournament_id
               AND previous.entry_id = roster.entry_id
               AND previous.event_id = ${event.event_id - 1}
             LIMIT 1
           ) AS previous_group_rank,
           (
             SELECT COALESCE(sum(history.event_net_points), 0)::integer
             FROM competition.tournament_points_group_results history
             JOIN fpl.events history_event
               ON history_event.season_id = history.season_id
              AND history_event.event_id = history.event_id
             WHERE history.season_id = roster.season_id
               AND history.tournament_id = roster.tournament_id
               AND history.entry_id = roster.entry_id
               AND history.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
           ) AS season_net_points,
           (
             SELECT count(*)::integer
             FROM competition.tournament_points_group_results history
             JOIN fpl.events history_event
               ON history_event.season_id = history.season_id
              AND history_event.event_id = history.event_id
             WHERE history.season_id = roster.season_id
               AND history.tournament_id = roster.tournament_id
               AND history.entry_id = roster.entry_id
               AND history.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
               AND history.event_net_points IS NOT NULL
               AND history.updated_at >= history_event.data_checked_at
           ) AS season_net_result_count,
           history_sources.source_min_checked_at AS history_source_min_checked_at,
           history_sources.source_max_checked_at AS history_source_max_checked_at
    FROM competition.tournament_entries roster
    JOIN competition.entries entry
      ON entry.season_id = roster.season_id AND entry.entry_id = roster.entry_id
    JOIN competition.tournaments tournament
      ON tournament.season_id = roster.season_id
     AND tournament.tournament_id = roster.tournament_id
    LEFT JOIN competition.entry_event_results result
      ON result.season_id = roster.season_id
     AND result.entry_id = roster.entry_id
     AND result.event_id = ${event.event_id}
    LEFT JOIN competition.tournament_points_group_results group_result
      ON group_result.season_id = roster.season_id
     AND group_result.tournament_id = roster.tournament_id
     AND group_result.entry_id = roster.entry_id
     AND group_result.event_id = ${event.event_id}
    LEFT JOIN LATERAL (
      SELECT min(source_checked_at) AS source_min_checked_at,
             max(source_checked_at) AS source_max_checked_at
      FROM (
        SELECT history.rich_synced_at AS source_checked_at
        FROM competition.entry_event_results history
        JOIN fpl.events history_event
          ON history_event.season_id = history.season_id
         AND history_event.event_id = history.event_id
        WHERE history.season_id = roster.season_id
          AND history.entry_id = roster.entry_id
          AND history.event_id >= GREATEST(
            COALESCE(tournament.group_started_event_id, 1),
            COALESCE(entry.started_event, 1)
          )
          AND history.event_id <= ${event.event_id}
          AND history_event.finished = true
          AND history_event.data_checked = true
          AND history_event.data_checked_at IS NOT NULL
          AND history.event_points IS NOT NULL
          AND history.rich_synced_at >= history_event.data_checked_at
        UNION ALL
        SELECT history.updated_at AS source_checked_at
        FROM competition.tournament_points_group_results history
        JOIN fpl.events history_event
          ON history_event.season_id = history.season_id
         AND history_event.event_id = history.event_id
        WHERE history.season_id = roster.season_id
          AND history.tournament_id = roster.tournament_id
          AND history.entry_id = roster.entry_id
          AND history.event_id >= GREATEST(
            COALESCE(tournament.group_started_event_id, 1),
            COALESCE(entry.started_event, 1)
          )
          AND history.event_id <= ${event.event_id}
          AND history_event.finished = true
          AND history_event.data_checked = true
          AND history_event.data_checked_at IS NOT NULL
          AND history.event_net_points IS NOT NULL
          AND history.updated_at >= history_event.data_checked_at
      ) validated_history
    ) history_sources ON true
    WHERE roster.season_id = ${seasonId}
      AND roster.tournament_id = ${tournament.tournament_id}
    ORDER BY roster.entry_id
  `;
  if (rows.length === 0 || rows.length !== tournament.total_team_num) {
    throw new TournamentReviewSourceNotReadyError('points roster is incomplete');
  }
  const notApplicable = rows.filter(
    (row) => !isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const applicable = rows.filter((row) => !notApplicable.includes(row));
  if (
    applicable.some(
      (row) =>
        row.event_points === null ||
        row.event_cost === null ||
        row.event_net_points === null ||
        row.rich_synced_at === null ||
        row.group_id === null ||
        row.event_group_rank === null ||
        row.group_event_net_points === null ||
        row.group_updated_at === null ||
        row.season_expected_event_count === null ||
        row.season_gross_result_count === null ||
        row.season_net_result_count === null ||
        row.history_source_min_checked_at === null ||
        row.history_source_max_checked_at === null ||
        row.season_gross_result_count !== row.season_expected_event_count ||
        row.season_net_result_count !== row.season_expected_event_count,
    )
  ) {
    throw new TournamentReviewSourceNotReadyError('points result rows are incomplete');
  }
  const sourceTimes: Array<Date | string | null> = rows.flatMap((row) => [
    row.entry_updated_at,
    row.roster_created_at,
  ]);
  sourceTimes.push(
    ...applicable.flatMap((row) => [
      row.rich_synced_at,
      row.group_updated_at,
      row.history_source_min_checked_at,
      row.history_source_max_checked_at,
    ]),
  );
  const rankFallback = new Map<number, number>();
  [...applicable]
    .sort((left, right) => {
      const byGroup = sortRank(left.event_group_rank, right.event_group_rank);
      if (byGroup !== 0) return byGroup;
      return integer(right.event_net_points) - integer(left.event_net_points);
    })
    .forEach((row, index) => rankFallback.set(row.entry_id, index + 1));
  const pointRows = rows.map((row) => ({
    entryId: row.entry_id,
    entryName: row.entry_name,
    playerName: row.player_name,
    applicable: !notApplicable.includes(row),
    groupId: row.group_id,
    rank: row.event_group_rank ?? rankFallback.get(row.entry_id) ?? null,
    previousRank: row.previous_group_rank,
    grossPoints: row.event_points,
    transferCost: row.event_cost,
    netPoints: row.event_net_points,
    tournamentScore: row.group_event_net_points,
    seasonNetPoints: row.season_net_points,
    seasonGrossPoints: row.season_gross_points,
    eventRank: row.event_rank,
    overallPoints: row.overall_points,
    overallRank: row.overall_rank,
  }));
  const grossPoints = applicable.map((row) => integer(row.event_points));
  const netPoints = applicable.map((row) => integer(row.event_net_points));
  return {
    payload: {
      ...header,
      points: {
        headline: 'gross',
        grossPointsTotal: grossPoints.reduce((sum, value) => sum + value, 0),
        grossPointsAverage: grossPoints.length
          ? Math.round(
              (grossPoints.reduce((sum, value) => sum + value, 0) / grossPoints.length) * 100,
            ) / 100
          : 0,
        netPointsTotal: netPoints.reduce((sum, value) => sum + value, 0),
        seasonGrossPointsTotal: applicable.reduce(
          (sum, row) => sum + integer(row.season_gross_points),
          0,
        ),
        seasonGrossPointsAverage: applicable.length
          ? Math.round(
              (applicable.reduce((sum, row) => sum + integer(row.season_gross_points), 0) /
                applicable.length) *
                100,
            ) / 100
          : 0,
        seasonNetPointsTotal: applicable.reduce(
          (sum, row) => sum + integer(row.season_net_points),
          0,
        ),
        rows: pointRows,
      },
    },
    rowCount: pointRows.length,
    expectedSubjectCount: rows.length,
    readySubjectCount: applicable.length,
    notApplicableSubjectCount: notApplicable.length,
    sourceTimes,
  };
}

type BattleSourceRow = {
  group_id: number;
  event_id: number;
  home_index: number;
  home_entry_id: number | null;
  home_net_points: number | null;
  home_rank: number | null;
  home_match_points: number | null;
  away_entry_id: number | null;
  away_index: number;
  away_net_points: number | null;
  away_rank: number | null;
  away_match_points: number | null;
  home_is_average: boolean;
  away_is_average: boolean;
  is_bye: boolean;
  source_order: number | null;
  event_data_checked_at?: Date | string | null;
  event_finished?: boolean;
  event_data_checked?: boolean;
  source_checked_at: Date | string | null;
  updated_at: Date | string;
};

type EntryScoreRow = {
  entry_id: number;
  entry_name: string;
  player_name: string;
  started_event: number | null;
  entry_updated_at: Date | string;
  roster_created_at: Date | string;
  event_points: number | null;
  event_transfers_cost: number | null;
  event_net_points: number | null;
  rich_synced_at: Date | string | null;
};

async function loadEntryScores(
  tx: postgres.TransactionSql,
  seasonId: number,
  eventId: number,
  tournamentId: number,
): Promise<Map<number, EntryScoreRow>> {
  const rows = await tx<EntryScoreRow[]>`
    SELECT roster.entry_id,
           entry.entry_name,
           entry.player_name,
           entry.started_event,
           entry.updated_at AS entry_updated_at,
           roster.created_at AS roster_created_at,
           result.event_points,
           result.event_transfers_cost,
           result.event_net_points,
           result.rich_synced_at
    FROM competition.tournament_entries roster
    JOIN competition.entries entry
      ON entry.season_id = roster.season_id AND entry.entry_id = roster.entry_id
    LEFT JOIN competition.entry_event_results result
      ON result.season_id = roster.season_id
     AND result.entry_id = roster.entry_id
     AND result.event_id = ${eventId}
    WHERE roster.season_id = ${seasonId} AND roster.tournament_id = ${tournamentId}
  `;
  return new Map(rows.map((row) => [row.entry_id, row]));
}

function requireFreshEntryScores(
  eligible: EntryScoreRow[],
  eventDataCheckedAt: Date,
  label: string,
): void {
  const missing = eligible.find(
    (row) =>
      row.event_points === null ||
      row.event_transfers_cost === null ||
      row.event_net_points === null ||
      row.rich_synced_at === null ||
      (asDate(row.rich_synced_at)?.getTime() ?? 0) < eventDataCheckedAt.getTime(),
  );
  if (missing) {
    throw new TournamentReviewSourceNotReadyError(`${label} entry score is missing or stale`);
  }
}

function battleSourceCheckedAt(match: BattleSourceRow): Date | null {
  const explicit = asDate(match.source_checked_at);
  if (explicit) return explicit;
  // Local battle rows have no official source order. Older rows created
  // before source_checked_at was written can use their durable computation
  // timestamp; official mirrors must retain their provider checkpoint.
  return match.source_order === null ? asDate(match.updated_at) : null;
}

export function hasCompleteTournamentReviewH2HGroupCoverage(input: {
  eligibleEntryIds: ReadonlySet<number>;
  entryGroupIds: ReadonlyMap<number, number>;
  matchCountByGroup: ReadonlyMap<number, number>;
  averageSidesByGroup: ReadonlyMap<number, number>;
}): boolean {
  const entryCountByGroup = new Map<number, number>();
  for (const entryId of input.eligibleEntryIds) {
    const groupId = input.entryGroupIds.get(entryId);
    if (groupId === undefined) return false;
    entryCountByGroup.set(groupId, (entryCountByGroup.get(groupId) ?? 0) + 1);
  }
  if (input.matchCountByGroup.size !== entryCountByGroup.size) return false;
  return [...entryCountByGroup].every(
    ([groupId, entryCount]) =>
      input.matchCountByGroup.get(groupId) === Math.ceil(entryCount / 2) &&
      (input.averageSidesByGroup.get(groupId) ?? 0) === entryCount % 2,
  );
}

export function rankTournamentReviewH2HStandings<
  T extends { entryId: number; matchPoints: number; pointsFor: number },
>(rows: readonly T[]): Array<T & { rank: number }> {
  const ordered = [...rows].sort(
    (left, right) =>
      right.matchPoints - left.matchPoints ||
      right.pointsFor - left.pointsFor ||
      left.entryId - right.entryId,
  );
  let previousKey: string | null = null;
  let rank = 0;
  return ordered.map((row, index) => {
    const key = `${row.matchPoints}:${row.pointsFor}`;
    if (key !== previousKey) rank = index + 1;
    previousKey = key;
    return { ...row, rank };
  });
}

export function isTournamentReviewEntryApplicable(
  startedEvent: number | null,
  eventId: number,
): boolean {
  return startedEvent === null || startedEvent <= eventId;
}

async function buildH2HPayload(
  tx: postgres.TransactionSql,
  seasonId: number,
  tournament: TournamentRow,
  event: EventRow,
  header: JsonRecord,
): Promise<{
  payload: JsonRecord;
  rowCount: number;
  expectedSubjectCount: number;
  readySubjectCount: number;
  notApplicableSubjectCount: number;
  sourceTimes: Array<Date | string | null>;
}> {
  const matches = await tx<BattleSourceRow[]>`
    SELECT group_id, event_id, home_index, home_entry_id, home_net_points, home_rank,
           home_match_points, away_entry_id, away_net_points, away_rank,
           away_match_points, away_index, home_is_average, away_is_average, is_bye,
           source_order,
           source_checked_at, updated_at
    FROM competition.tournament_battle_group_results
    WHERE season_id = ${seasonId}
      AND tournament_id = ${tournament.tournament_id}
      AND event_id = ${event.event_id}
    ORDER BY group_id,
             COALESCE(source_order, home_index),
             home_index,
             away_index,
             source_result_id
  `;
  if (matches.length === 0) {
    throw new TournamentReviewSourceNotReadyError('H2H match rows are missing');
  }
  const scores = await loadEntryScores(tx, seasonId, event.event_id, tournament.tournament_id);
  if (scores.size === 0 || scores.size !== tournament.total_team_num) {
    throw new TournamentReviewSourceNotReadyError('H2H roster is incomplete');
  }
  const eligible = [...scores.values()].filter((row) =>
    isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const notApplicable = [...scores.values()].filter(
    (row) => !isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const eventDataCheckedAt = asDate(event.data_checked_at);
  if (!eventDataCheckedAt) {
    throw new TournamentReviewSourceNotReadyError('H2H event data_checked_at is missing');
  }
  requireFreshEntryScores(eligible, eventDataCheckedAt, 'H2H');
  const covered = new Set<number>();
  const seenCurrentEntries = new Set<number>();
  const entryGroupIds = new Map<number, number>();
  const currentParticipantIds = new Set(scores.keys());
  const currentMatchCountByGroup = new Map<number, number>();
  const currentAverageSidesByGroup = new Map<number, number>();
  const sourceTimes: Array<Date | string | null> = [...scores.values()].flatMap((row) => [
    row.entry_updated_at,
    row.roster_created_at,
  ]);
  sourceTimes.push(...eligible.map((row) => row.rich_synced_at));
  const matchRows = matches.map((match, index) => {
    currentMatchCountByGroup.set(
      match.group_id,
      (currentMatchCountByGroup.get(match.group_id) ?? 0) + 1,
    );
    if (
      (match.home_entry_id === null) !== match.home_is_average ||
      (match.away_entry_id === null) !== match.away_is_average ||
      (match.home_entry_id === null && match.away_entry_id === null)
    ) {
      throw new TournamentReviewSourceNotReadyError('H2H match side contract is invalid');
    }
    const home = match.home_entry_id === null ? null : scores.get(match.home_entry_id);
    const away = match.away_entry_id === null ? null : scores.get(match.away_entry_id);
    if (match.home_entry_id !== null && !match.home_is_average && !home) {
      throw new TournamentReviewSourceNotReadyError('H2H home entry is outside the roster');
    }
    if (match.away_entry_id !== null && !match.away_is_average && !away) {
      throw new TournamentReviewSourceNotReadyError('H2H away entry is outside the roster');
    }
    if (match.home_entry_id !== null && !match.home_is_average) covered.add(match.home_entry_id);
    if (match.away_entry_id !== null && !match.away_is_average) covered.add(match.away_entry_id);
    for (const [entryId, isAverage] of [
      [match.home_entry_id, match.home_is_average],
      [match.away_entry_id, match.away_is_average],
    ] as const) {
      if (isAverage) {
        currentAverageSidesByGroup.set(
          match.group_id,
          (currentAverageSidesByGroup.get(match.group_id) ?? 0) + 1,
        );
        continue;
      }
      if (
        entryId === null ||
        !currentParticipantIds.has(entryId) ||
        seenCurrentEntries.has(entryId)
      ) {
        throw new TournamentReviewSourceNotReadyError(
          'H2H match participant is outside the roster',
        );
      }
      const existingGroupId = entryGroupIds.get(entryId);
      if (existingGroupId !== undefined && existingGroupId !== match.group_id) {
        throw new TournamentReviewSourceNotReadyError('H2H entry changed groups');
      }
      entryGroupIds.set(entryId, match.group_id);
      seenCurrentEntries.add(entryId);
    }
    if (
      !match.is_bye &&
      (match.home_net_points === null ||
        match.home_match_points === null ||
        match.away_net_points === null ||
        match.away_match_points === null)
    ) {
      throw new TournamentReviewSourceNotReadyError('H2H match score is incomplete');
    }
    const sourceCheckedAt = battleSourceCheckedAt(match);
    if (!sourceCheckedAt) {
      throw new TournamentReviewSourceNotReadyError('H2H match source timestamp is missing');
    }
    // Keep both timestamps in the freshness span. A present but stale
    // source_checked_at must not be hidden by a newer row updated_at.
    sourceTimes.push(sourceCheckedAt, match.updated_at);
    return {
      matchId: `${event.event_id}-${index + 1}`,
      groupId: match.group_id,
      home: match.home_is_average
        ? {
            entryId: null,
            entryName: 'Average Team',
            isAverage: true,
            grossPoints: null,
            transferCost: null,
            netPoints: match.home_net_points,
            matchPoints: match.home_match_points,
            rank: match.home_rank,
          }
        : home
          ? {
              entryId: home.entry_id,
              entryName: home.entry_name,
              isAverage: false,
              grossPoints: home.event_points,
              transferCost: home.event_transfers_cost,
              netPoints: match.home_net_points,
              matchPoints: match.home_match_points,
              rank: match.home_rank,
            }
          : null,
      away: match.away_is_average
        ? {
            entryId: null,
            entryName: 'Average Team',
            isAverage: true,
            grossPoints: null,
            transferCost: null,
            netPoints: match.away_net_points,
            matchPoints: match.away_match_points,
            rank: match.away_rank,
          }
        : away
          ? {
              entryId: away.entry_id,
              entryName: away.entry_name,
              isAverage: false,
              grossPoints: away.event_points,
              transferCost: away.event_transfers_cost,
              netPoints: match.away_net_points,
              matchPoints: match.away_match_points,
              rank: match.away_rank,
            }
          : null,
      isBye: match.is_bye,
    };
  });
  if (
    covered.size !== scores.size ||
    [...scores.keys()].some((entryId) => !covered.has(entryId)) ||
    !hasCompleteTournamentReviewH2HGroupCoverage({
      eligibleEntryIds: currentParticipantIds,
      entryGroupIds,
      matchCountByGroup: currentMatchCountByGroup,
      averageSidesByGroup: currentAverageSidesByGroup,
    })
  ) {
    throw new TournamentReviewSourceNotReadyError('H2H roster coverage is incomplete');
  }

  const history = await tx<BattleSourceRow[]>`
    SELECT battle.group_id, battle.event_id, battle.home_index, battle.home_entry_id,
           battle.home_net_points,
           battle.home_rank, battle.home_match_points, battle.away_entry_id,
           battle.away_net_points, battle.away_rank,
           battle.away_match_points, battle.away_index, battle.home_is_average,
           battle.away_is_average, battle.is_bye, battle.source_order,
           battle.source_checked_at, battle.updated_at,
           event.finished AS event_finished,
           event.data_checked AS event_data_checked,
           event.data_checked_at AS event_data_checked_at
    FROM competition.tournament_battle_group_results battle
    JOIN fpl.events event
      ON event.season_id = battle.season_id
     AND event.event_id = battle.event_id
    WHERE battle.season_id = ${seasonId}
      AND battle.tournament_id = ${tournament.tournament_id}
      AND battle.event_id >= COALESCE(${tournament.group_started_event_id}, 1)
      AND battle.event_id <= ${event.event_id}
    ORDER BY battle.event_id,
             battle.group_id,
             COALESCE(battle.source_order, battle.home_index),
             battle.home_index,
             battle.away_index,
             battle.source_result_id
  `;
  const expectedHistoryEvents = await tx<Array<{ event_id: number }>>`
    SELECT event.event_id
    FROM fpl.events event
    WHERE event.season_id = ${seasonId}
      AND event.event_id >= COALESCE(${tournament.group_started_event_id}, 1)
      AND event.event_id <= ${event.event_id}
      AND event.finished = true
      AND event.data_checked = true
      AND event.data_checked_at IS NOT NULL
    ORDER BY event.event_id
  `;
  const historyEventIds = new Set(history.map((match) => match.event_id));
  if (expectedHistoryEvents.some((row) => !historyEventIds.has(row.event_id))) {
    throw new TournamentReviewSourceNotReadyError('H2H history event coverage is incomplete');
  }
  const historyByEvent = new Map<number, BattleSourceRow[]>();
  for (const match of history) {
    const eventMatches = historyByEvent.get(match.event_id) ?? [];
    eventMatches.push(match);
    historyByEvent.set(match.event_id, eventMatches);
  }
  for (const expectedEvent of expectedHistoryEvents) {
    const eventMatches = historyByEvent.get(expectedEvent.event_id) ?? [];
    const eventParticipants = [...scores.values()];
    const eventParticipantIds = new Set(eventParticipants.map((row) => row.entry_id));
    const seenEntries = new Set<number>();
    const eventMatchCountByGroup = new Map<number, number>();
    const eventAverageSidesByGroup = new Map<number, number>();
    for (const match of eventMatches) {
      eventMatchCountByGroup.set(
        match.group_id,
        (eventMatchCountByGroup.get(match.group_id) ?? 0) + 1,
      );
      for (const [entryId, isAverage] of [
        [match.home_entry_id, match.home_is_average],
        [match.away_entry_id, match.away_is_average],
      ] as const) {
        if (isAverage) {
          eventAverageSidesByGroup.set(
            match.group_id,
            (eventAverageSidesByGroup.get(match.group_id) ?? 0) + 1,
          );
          continue;
        }
        if (entryId === null || !eventParticipantIds.has(entryId) || seenEntries.has(entryId)) {
          throw new TournamentReviewSourceNotReadyError(
            'H2H history participant coverage is invalid',
          );
        }
        const existingGroupId = entryGroupIds.get(entryId);
        if (existingGroupId !== undefined && existingGroupId !== match.group_id) {
          throw new TournamentReviewSourceNotReadyError('H2H history entry changed groups');
        }
        entryGroupIds.set(entryId, match.group_id);
        seenEntries.add(entryId);
      }
    }
    if (
      seenEntries.size !== eventParticipants.length ||
      !hasCompleteTournamentReviewH2HGroupCoverage({
        eligibleEntryIds: eventParticipantIds,
        entryGroupIds,
        matchCountByGroup: eventMatchCountByGroup,
        averageSidesByGroup: eventAverageSidesByGroup,
      })
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'H2H history participant coverage is incomplete',
      );
    }
  }
  type H2HStanding = {
    groupId: number;
    entryId: number;
    entryName: string;
    played: number;
    won: number;
    drawn: number;
    lost: number;
    matchPoints: number;
    pointsFor: number;
    pointsAgainst: number;
  };
  const standingsByGroup = new Map<number, Map<number, H2HStanding>>();
  const ensureStanding = (groupId: number, entryId: number) => {
    const groupStandings = standingsByGroup.get(groupId) ?? new Map<number, H2HStanding>();
    const existing = groupStandings.get(entryId);
    if (existing) return existing;
    const score = scores.get(entryId);
    const value = {
      groupId,
      entryId,
      entryName: score?.entry_name ?? `Entry ${entryId}`,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      matchPoints: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    };
    groupStandings.set(entryId, value);
    standingsByGroup.set(groupId, groupStandings);
    return value;
  };
  for (const [entryId, groupId] of entryGroupIds) ensureStanding(groupId, entryId);
  for (const match of history) {
    const historyCheckpoint = asDate(match.event_data_checked_at);
    if (!historyCheckpoint || match.event_finished !== true || match.event_data_checked !== true) {
      throw new TournamentReviewSourceNotReadyError('H2H history event is not finalized');
    }
    const historySourceCheckedAt = battleSourceCheckedAt(match);
    const historySourceDates = [historySourceCheckedAt, match.updated_at]
      .map(asDate)
      .filter((date): date is Date => date !== null);
    if (
      historySourceDates.length === 0 ||
      historySourceDates.some((date) => date.getTime() < historyCheckpoint.getTime())
    ) {
      throw new TournamentReviewSourceNotReadyError('H2H history source rows are stale');
    }
    sourceTimes.push(...historySourceDates);
    if (!historySourceCheckedAt) {
      throw new TournamentReviewSourceNotReadyError('H2H history source timestamp is missing');
    }
    if (
      (match.home_entry_id !== null &&
        !match.home_is_average &&
        !scores.has(match.home_entry_id)) ||
      (match.away_entry_id !== null && !match.away_is_average && !scores.has(match.away_entry_id))
    ) {
      throw new TournamentReviewSourceNotReadyError('H2H history entry is outside the roster');
    }
    if (
      (match.home_entry_id === null) !== match.home_is_average ||
      (match.away_entry_id === null) !== match.away_is_average ||
      (match.home_entry_id === null && match.away_entry_id === null)
    ) {
      throw new TournamentReviewSourceNotReadyError('H2H history side contract is invalid');
    }
    if (
      match.is_bye ||
      match.home_net_points === null ||
      match.away_net_points === null ||
      match.home_match_points === null ||
      match.away_match_points === null
    ) {
      if (match.is_bye) continue;
      throw new TournamentReviewSourceNotReadyError('H2H history score is incomplete');
    }

    const home =
      match.home_entry_id === null ? null : ensureStanding(match.group_id, match.home_entry_id);
    const away =
      match.away_entry_id === null ? null : ensureStanding(match.group_id, match.away_entry_id);
    if (home) {
      home.played += 1;
      home.pointsFor += match.home_net_points;
      home.pointsAgainst += match.away_net_points;
      home.matchPoints += match.home_match_points;
      if (match.home_net_points > match.away_net_points) home.won += 1;
      else if (match.home_net_points < match.away_net_points) home.lost += 1;
      else home.drawn += 1;
    }
    if (away) {
      away.played += 1;
      away.pointsFor += match.away_net_points;
      away.pointsAgainst += match.home_net_points;
      away.matchPoints += match.away_match_points;
      if (match.away_net_points > match.home_net_points) away.won += 1;
      else if (match.away_net_points < match.home_net_points) away.lost += 1;
      else away.drawn += 1;
    }
  }
  const standingRows = [...standingsByGroup.entries()]
    .sort(([leftGroupId], [rightGroupId]) => leftGroupId - rightGroupId)
    .flatMap(([, groupStandings]) =>
      rankTournamentReviewH2HStandings([...groupStandings.values()]),
    );
  return {
    payload: {
      ...header,
      h2h: { matches: matchRows, standings: standingRows },
    },
    rowCount: matchRows.length,
    expectedSubjectCount: scores.size,
    readySubjectCount: eligible.length,
    notApplicableSubjectCount: notApplicable.length,
    sourceTimes,
  };
}

type KnockoutSourceRow = {
  event_id: number;
  match_id: number;
  play_against_id: number;
  round: number | null;
  knockout_name: string | null;
  home_entry_id: number | null;
  home_net_points: number | null;
  home_goals_scored: number | null;
  home_goals_conceded: number | null;
  away_entry_id: number | null;
  away_net_points: number | null;
  away_goals_scored: number | null;
  away_goals_conceded: number | null;
  match_winner: number | null;
  official_match_id: number | null;
  source_checked_at: Date | string | null;
  updated_at: Date | string;
};

type KnockoutBracketSourceRow = {
  match_id: number;
  round: number;
  started_event_id: number;
  ended_event_id: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  updated_at: Date | string;
};

async function buildKnockoutPayload(
  tx: postgres.TransactionSql,
  seasonId: number,
  tournament: TournamentRow,
  event: EventRow,
  header: JsonRecord,
): Promise<{
  payload: JsonRecord;
  rowCount: number;
  expectedSubjectCount: number;
  readySubjectCount: number;
  notApplicableSubjectCount: number;
  sourceTimes: Array<Date | string | null>;
}> {
  const brackets = await tx<KnockoutBracketSourceRow[]>`
    SELECT match_id,
           round,
           started_event_id,
           ended_event_id,
           home_entry_id,
           away_entry_id,
           updated_at
    FROM competition.tournament_knockouts
    WHERE season_id = ${seasonId}
      AND tournament_id = ${tournament.tournament_id}
      AND started_event_id IS NOT NULL
      AND started_event_id <= ${event.event_id}
      AND (ended_event_id IS NULL OR ended_event_id >= ${event.event_id})
    ORDER BY round, match_id
  `;
  if (brackets.length === 0) {
    throw new TournamentReviewSourceNotReadyError('knockout bracket rows are missing');
  }
  const expectedByKey = new Map<
    string,
    {
      round: number;
      homeEntryId: number | null;
      awayEntryId: number | null;
    }
  >();
  for (const bracket of brackets) {
    const playAgainstId = event.event_id - bracket.started_event_id + 1;
    if (playAgainstId < 1) {
      throw new TournamentReviewSourceNotReadyError('knockout bracket event coverage is invalid');
    }
    const swap = playAgainstId % 2 === 0;
    expectedByKey.set(`${bracket.match_id}:${playAgainstId}`, {
      round: bracket.round,
      homeEntryId: swap ? bracket.away_entry_id : bracket.home_entry_id,
      awayEntryId: swap ? bracket.home_entry_id : bracket.away_entry_id,
    });
  }
  const matches = await tx<KnockoutSourceRow[]>`
    SELECT result.event_id,
           result.match_id,
           result.play_against_id,
           bracket.round,
           result.knockout_name,
           result.home_entry_id,
           result.home_net_points,
           result.home_goals_scored,
           result.home_goals_conceded,
           result.away_entry_id,
           result.away_net_points,
           result.away_goals_scored,
           result.away_goals_conceded,
           result.match_winner,
           result.official_match_id,
           result.source_checked_at,
           result.updated_at
    FROM competition.tournament_knockout_results result
    LEFT JOIN competition.tournament_knockouts bracket
      ON bracket.season_id = result.season_id
     AND bracket.tournament_id = result.tournament_id
     AND bracket.match_id = result.match_id
    WHERE result.season_id = ${seasonId}
      AND result.tournament_id = ${tournament.tournament_id}
      AND result.event_id = ${event.event_id}
    ORDER BY COALESCE(bracket.round, 2147483647), result.match_id, result.play_against_id
  `;
  if (matches.length === 0) {
    throw new TournamentReviewSourceNotReadyError('knockout match rows are missing');
  }
  const scores = await loadEntryScores(tx, seasonId, event.event_id, tournament.tournament_id);
  if (scores.size === 0 || scores.size !== tournament.total_team_num) {
    throw new TournamentReviewSourceNotReadyError('knockout roster is incomplete');
  }
  const eligible = [...scores.values()].filter((row) =>
    isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const notApplicable = [...scores.values()].filter(
    (row) => !isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const eventDataCheckedAt = asDate(event.data_checked_at);
  if (!eventDataCheckedAt) {
    throw new TournamentReviewSourceNotReadyError('knockout event data_checked_at is missing');
  }
  requireFreshEntryScores(eligible, eventDataCheckedAt, 'knockout');
  const sourceTimes: Array<Date | string | null> = [...scores.values()].flatMap((row) => [
    row.entry_updated_at,
    row.roster_created_at,
  ]);
  sourceTimes.push(...brackets.map((bracket) => bracket.updated_at));
  sourceTimes.push(...eligible.map((row) => row.rich_synced_at));
  const actualKeys = new Set<string>();
  if (matches.length !== expectedByKey.size) {
    throw new TournamentReviewSourceNotReadyError('knockout result coverage is incomplete');
  }
  const matchRows = matches.map((match) => {
    const key = `${match.match_id}:${match.play_against_id}`;
    const expected = expectedByKey.get(key);
    if (!expected || actualKeys.has(key)) {
      throw new TournamentReviewSourceNotReadyError('knockout result coverage is invalid');
    }
    actualKeys.add(key);
    if (
      match.home_entry_id !== expected.homeEntryId ||
      match.away_entry_id !== expected.awayEntryId
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'knockout result participants are inconsistent',
      );
    }
    if (match.match_winner === null) {
      throw new TournamentReviewSourceNotReadyError('knockout result winner is missing');
    }
    if (match.home_entry_id !== null && match.home_net_points === null) {
      throw new TournamentReviewSourceNotReadyError('knockout home score is incomplete');
    }
    if (match.away_entry_id !== null && match.away_net_points === null) {
      throw new TournamentReviewSourceNotReadyError('knockout away score is incomplete');
    }
    if (
      match.official_match_id === null &&
      ((match.home_entry_id !== null &&
        (match.home_goals_scored === null || match.home_goals_conceded === null)) ||
        (match.away_entry_id !== null &&
          (match.away_goals_scored === null || match.away_goals_conceded === null)))
    ) {
      throw new TournamentReviewSourceNotReadyError('knockout goal fields are incomplete');
    }
    const sourceCheckedAt =
      asDate(match.source_checked_at) ??
      (match.official_match_id === null ? asDate(match.updated_at) : null);
    if (!sourceCheckedAt) {
      throw new TournamentReviewSourceNotReadyError('knockout match source timestamp is missing');
    }
    if (sourceCheckedAt.getTime() < eventDataCheckedAt.getTime()) {
      throw new TournamentReviewSourceNotReadyError('knockout match source is stale');
    }
    // Keep both timestamps in the freshness span. A present but stale
    // source_checked_at must not be hidden by a newer row updated_at.
    sourceTimes.push(sourceCheckedAt, match.updated_at);
    const home = match.home_entry_id === null ? null : scores.get(match.home_entry_id);
    const away = match.away_entry_id === null ? null : scores.get(match.away_entry_id);
    if (!home && !away) {
      throw new TournamentReviewSourceNotReadyError('knockout match has no roster side');
    }
    if (match.home_entry_id !== null && !home) {
      throw new TournamentReviewSourceNotReadyError('knockout home entry is outside the roster');
    }
    if (match.away_entry_id !== null && !away) {
      throw new TournamentReviewSourceNotReadyError('knockout away entry is outside the roster');
    }
    if (
      match.match_winner !== null &&
      (!scores.has(match.match_winner) ||
        (match.match_winner !== match.home_entry_id && match.match_winner !== match.away_entry_id))
    ) {
      throw new TournamentReviewSourceNotReadyError('knockout winner is outside the match');
    }
    return {
      round: expected.round,
      name: match.knockout_name,
      matchId: match.match_id,
      playAgainstId: match.play_against_id,
      home: home
        ? {
            entryId: home.entry_id,
            entryName: home.entry_name,
            grossPoints: home.event_points,
            transferCost: home.event_transfers_cost,
            netPoints: match.home_net_points,
            goalsScored: match.home_goals_scored,
            goalsConceded: match.home_goals_conceded,
          }
        : null,
      away: away
        ? {
            entryId: away.entry_id,
            entryName: away.entry_name,
            grossPoints: away.event_points,
            transferCost: away.event_transfers_cost,
            netPoints: match.away_net_points,
            goalsScored: match.away_goals_scored,
            goalsConceded: match.away_goals_conceded,
          }
        : null,
      winnerEntryId: match.match_winner,
    };
  });
  return {
    payload: { ...header, knockout: { matches: matchRows } },
    rowCount: matchRows.length,
    expectedSubjectCount: scores.size,
    readySubjectCount: eligible.length,
    notApplicableSubjectCount: notApplicable.length,
    sourceTimes,
  };
}

async function loadReviewContext(
  tx: postgres.TransactionSql,
  seasonId: number,
  tournamentId: number,
  eventId: number,
): Promise<{ tournament: TournamentRow; event: EventRow; format: TournamentReviewFormat }> {
  const tournaments = await tx<TournamentRow[]>`
    SELECT tournament_id,
           name AS tournament_name,
           creator,
           admin_entry_id,
           league_id,
           league_type,
           total_team_num,
           group_mode,
           group_started_event_id,
           group_ended_event_id,
           knockout_mode,
           knockout_started_event_id,
           knockout_ended_event_id,
           setup_status,
           setup_finished_at,
           standings_ready_at
    FROM competition.tournaments
    WHERE season_id = ${seasonId} AND tournament_id = ${tournamentId}
    LIMIT 1
  `;
  const events = await tx<EventRow[]>`
    SELECT event_id, name AS event_name, finished, data_checked, data_checked_at
    FROM fpl.events
    WHERE season_id = ${seasonId} AND event_id = ${eventId}
    LIMIT 1
  `;
  const tournament = tournaments[0];
  const event = events[0];
  if (!tournament || !event)
    throw new TournamentReviewSourceNotReadyError('review scope is missing');
  const format = resolveTournamentReviewFormat(
    {
      groupMode: tournament.group_mode,
      groupStartedEventId: tournament.group_started_event_id,
      groupEndedEventId: tournament.group_ended_event_id,
      knockoutMode: tournament.knockout_mode,
      knockoutStartedEventId: tournament.knockout_started_event_id,
      knockoutEndedEventId: tournament.knockout_ended_event_id,
    },
    eventId,
  );
  if (!format) throw new TournamentReviewSourceNotReadyError('event is outside the review window');
  if (!event.finished || !event.data_checked || !event.data_checked_at) {
    throw new TournamentReviewSourceNotReadyError('event is not finalized');
  }
  if (tournament.setup_status !== 'ready') {
    throw new TournamentReviewSourceNotReadyError('tournament setup is not ready');
  }
  return { tournament, event, format };
}

async function publishTournamentReviewScopeOnce(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
): Promise<TournamentReviewPublicationResult> {
  const client = await getDbClient();
  return client.begin('isolation level repeatable read', async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${season.seasonId}:${tournamentId}:${eventId}`}, 0))`;
    const { tournament, event, format } = await loadReviewContext(
      tx,
      season.seasonId,
      tournamentId,
      eventId,
    );
    const eventDataCheckedAt = asDate(event.data_checked_at);
    if (!eventDataCheckedAt)
      throw new TournamentReviewSourceNotReadyError('data_checked_at missing');
    const header = eventReviewPayload(tournament, event, format, {
      sourceMin: eventDataCheckedAt,
      sourceMax: eventDataCheckedAt,
    });
    const built =
      format === 'POINTS'
        ? await buildPointsPayload(tx, season.seasonId, tournament, event, header)
        : format === 'H2H'
          ? await buildH2HPayload(tx, season.seasonId, tournament, event, header)
          : await buildKnockoutPayload(tx, season.seasonId, tournament, event, header);
    const freshness = sourceSpan([eventDataCheckedAt, ...built.sourceTimes]);
    const payload = {
      ...built.payload,
      freshness: {
        sourceMinCheckedAt: freshness.sourceMin.toISOString(),
        sourceMaxCheckedAt: freshness.sourceMax.toISOString(),
      },
    };
    const contentSha256 = createHash('sha256')
      .update(postgresJsonbCanonicalJson(payload), 'utf8')
      .digest('hex');
    const existing = await tx<Array<{ revision: number | string; published_at: Date | string }>>`
      SELECT revision, published_at
      FROM competition.tournament_review_publications
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND event_id = ${eventId}
        AND content_sha256 = ${contentSha256}
      ORDER BY revision DESC
      LIMIT 1
    `;
    let revision: number;
    let publishedAt: Date;
    let state: 'PUBLISHED' | 'REUSED';
    if (existing[0]) {
      revision = Number(existing[0].revision);
      publishedAt = asDate(existing[0].published_at) ?? new Date();
      state = 'REUSED';
    } else {
      const revisionRows = await tx<Array<{ revision: number | string }>>`
        SELECT COALESCE(max(revision), 0)::bigint + 1 AS revision
        FROM competition.tournament_review_publications
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
          AND event_id = ${eventId}
      `;
      revision = Number(revisionRows[0]?.revision ?? 1);
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw new TournamentReviewPublicationError('review revision allocation failed');
      }
      const inserted = await tx<Array<{ published_at: Date | string }>>`
        INSERT INTO competition.tournament_review_publications (
          season_id, tournament_id, event_id, revision, format,
          schema_version, metric_version, event_data_checked_at,
          source_min_checked_at, source_max_checked_at,
          expected_subject_count, ready_subject_count, not_applicable_subject_count,
          row_count, content_sha256, payload
        ) VALUES (
          ${season.seasonId}, ${tournamentId}, ${eventId}, ${revision}, ${format},
          ${TOURNAMENT_REVIEW_SCHEMA_VERSION}, ${TOURNAMENT_REVIEW_METRIC_VERSION},
          ${eventDataCheckedAt.toISOString()}::timestamptz,
          ${freshness.sourceMin.toISOString()}::timestamptz,
          ${freshness.sourceMax.toISOString()}::timestamptz,
          ${built.expectedSubjectCount}, ${built.readySubjectCount},
          ${built.notApplicableSubjectCount}, ${built.rowCount}, ${contentSha256},
          ${JSON.stringify(payload)}::jsonb
        ) RETURNING published_at
      `;
      publishedAt = asDate(inserted[0]?.published_at) ?? new Date();
      state = 'PUBLISHED';
    }
    await tx`
      INSERT INTO competition.tournament_review_heads
        (season_id, tournament_id, event_id, revision, content_sha256, published_at, updated_at)
      VALUES
        (${season.seasonId}, ${tournamentId}, ${eventId}, ${revision}, ${contentSha256},
         ${publishedAt.toISOString()}::timestamptz, clock_timestamp())
      ON CONFLICT (season_id, tournament_id, event_id) DO UPDATE
      SET revision = EXCLUDED.revision,
          content_sha256 = EXCLUDED.content_sha256,
          published_at = EXCLUDED.published_at,
          updated_at = clock_timestamp()
    `;
    logInfo('Published tournament review scope', {
      season: season.seasonCode,
      tournamentId,
      eventId,
      format,
      revision,
      state,
      rowCount: built.rowCount,
    });
    return {
      seasonId: season.seasonId,
      tournamentId,
      eventId,
      revision,
      format,
      contentSha256,
      rowCount: built.rowCount,
      expectedSubjectCount: built.expectedSubjectCount,
      readySubjectCount: built.readySubjectCount,
      notApplicableSubjectCount: built.notApplicableSubjectCount,
      publishedAt,
      state,
    };
  });
}

export async function publishTournamentReviewScope(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
): Promise<TournamentReviewPublicationResult> {
  if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
    throw new Error('tournamentId must be a positive integer');
  }
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 38) {
    throw new Error('eventId must be between 1 and 38');
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await publishTournamentReviewScopeOnce(season, tournamentId, eventId);
    } catch (error) {
      // Source readiness is a durable obligation concern. Do not spin three
      // immediate reads against an upstream that is still settling; the
      // obligation scheduler records one recheck and applies 60/180/600s
      // delays. Transient database conflicts still get a short in-process
      // retry because they are not a source freshness signal.
      if (error instanceof TournamentReviewSourceNotReadyError) throw error;
      lastError = error;
      const code = 'PUBLISH_CONFLICT';
      const retryable =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code?: unknown }).code === '40001' ||
          (error as { code?: unknown }).code === '23505');
      if (!retryable || attempt === 3) throw error;
      logInfo('Retrying tournament review publication', {
        season: season.seasonCode,
        tournamentId,
        eventId,
        attempt,
        code,
      });
    }
  }
  throw lastError;
}

export async function reconcileTournamentReviewObligations(
  season: FplSeasonRef,
  now = new Date(),
): Promise<number> {
  const rows = await withDatabaseTransaction(async (tx) => {
    // Take the scope locks in a statement of their own. PostgreSQL assigns a
    // statement snapshot before evaluating a locking CTE; keeping the lock
    // acquisition separate ensures the retirement snapshot includes any
    // publisher that was already holding the scope lock.
    await tx`
      WITH stored_scopes AS (
        SELECT tournament_id, event_id
        FROM competition.tournament_review_heads
        WHERE season_id = ${season.seasonId}
        UNION
        SELECT tournament_id, event_id
        FROM competition.tournament_review_obligations
        WHERE season_id = ${season.seasonId}
      ), ordered_scopes AS MATERIALIZED (
        SELECT tournament_id, event_id
        FROM stored_scopes
        ORDER BY tournament_id, event_id
      )
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          'review:' || ${season.seasonId}::text || ':' || ordered.tournament_id::text || ':' || ordered.event_id::text,
          0
        )
      )
      FROM ordered_scopes ordered
    `;
    return tx<
      Array<{
        upserted_count: number | string;
        retired_head_count: number | string;
        retired_obligation_count: number | string;
      }>
    >`
    WITH candidate_formats AS (
      SELECT tournament.tournament_id,
             event.event_id,
             event.name AS event_name,
             event.updated_at AS event_updated_at,
             CASE
               WHEN tournament.knockout_mode <> 'no_knockout'
                AND tournament.knockout_started_event_id IS NOT NULL
                AND event.event_id >= tournament.knockout_started_event_id
                AND (tournament.knockout_ended_event_id IS NULL OR event.event_id <= tournament.knockout_ended_event_id)
                 THEN 'KNOCKOUT'
               WHEN tournament.group_mode = 'points_races'
                AND tournament.group_started_event_id IS NOT NULL
                AND event.event_id >= tournament.group_started_event_id
                AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
                 THEN 'POINTS'
               WHEN tournament.group_mode = 'battle_races'
                AND tournament.group_started_event_id IS NOT NULL
                AND event.event_id >= tournament.group_started_event_id
                AND (tournament.group_ended_event_id IS NULL OR event.event_id <= tournament.group_ended_event_id)
                 THEN 'H2H'
             END AS format,
             GREATEST(
               event.data_checked_at,
               COALESCE(tournament.setup_finished_at, '-infinity'::timestamptz),
               COALESCE(tournament.standings_ready_at, '-infinity'::timestamptz),
               COALESCE(tournament.updated_at, '-infinity'::timestamptz)
             ) AS base_eligible_at
      FROM competition.tournaments tournament
      JOIN fpl.events event ON event.season_id = tournament.season_id
      WHERE tournament.season_id = ${season.seasonId}
        AND tournament.setup_status = 'ready'
        AND event.finished = true
        AND event.data_checked = true
        AND event.data_checked_at IS NOT NULL
    ), candidate_states AS (
      SELECT candidate.tournament_id,
             candidate.event_id,
             candidate.event_name,
             candidate.event_updated_at,
             candidate.format,
             candidate.base_eligible_at,
             existing.eligible_at AS existing_eligible_at
      FROM candidate_formats candidate
      LEFT JOIN competition.tournament_review_obligations existing
        ON existing.season_id = ${season.seasonId}
       AND existing.tournament_id = candidate.tournament_id
       AND existing.event_id = candidate.event_id
    ), candidates AS (
      SELECT state.tournament_id,
             state.event_id,
             state.format,
             GREATEST(
               state.base_eligible_at,
               COALESCE(source.max_source_updated_at, '-infinity'::timestamptz)
             ) AS eligible_at
      FROM candidate_states state
      LEFT JOIN LATERAL (
        -- For a new obligation existing_eligible_at is NULL, so the probe
        -- seeds its watermark from rows visible in this reconciliation
        -- snapshot. Existing obligations only see post-watermark changes.
        SELECT max(source_updated_at) AS max_source_updated_at
        FROM (
          SELECT GREATEST(entry.updated_at, roster.created_at) AS source_updated_at
          FROM competition.tournament_entries roster
          JOIN competition.entries entry
            ON entry.season_id = roster.season_id
           AND entry.entry_id = roster.entry_id
          WHERE roster.season_id = ${season.seasonId}
            AND roster.tournament_id = state.tournament_id
            AND GREATEST(entry.updated_at, roster.created_at) > COALESCE(
              state.existing_eligible_at,
              '-infinity'::timestamptz
            )
          UNION ALL
          SELECT state.event_updated_at AS source_updated_at
          WHERE state.event_updated_at > COALESCE(
              state.existing_eligible_at,
              '-infinity'::timestamptz
            )
            AND (
              SELECT publication.payload #>> '{event,name}'
              FROM competition.tournament_review_heads head
              JOIN competition.tournament_review_publications publication
                ON publication.season_id = head.season_id
               AND publication.tournament_id = head.tournament_id
               AND publication.event_id = head.event_id
               AND publication.revision = head.revision
              WHERE head.season_id = ${season.seasonId}
                AND head.tournament_id = state.tournament_id
                AND head.event_id = state.event_id
              LIMIT 1
            ) IS DISTINCT FROM state.event_name
          UNION ALL
          SELECT GREATEST(
                   result.updated_at,
                   COALESCE(result.rich_synced_at, '-infinity'::timestamptz)
                 ) AS source_updated_at
          FROM competition.entry_event_results result
          JOIN competition.tournament_entries roster
            ON roster.season_id = result.season_id
           AND roster.entry_id = result.entry_id
           AND roster.tournament_id = state.tournament_id
          WHERE state.format IN ('POINTS', 'H2H')
            AND result.season_id = ${season.seasonId}
            AND result.event_id <= state.event_id
            AND GREATEST(
              result.updated_at,
              COALESCE(result.rich_synced_at, '-infinity'::timestamptz)
            ) > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT points.updated_at AS source_updated_at
          FROM competition.tournament_points_group_results points
          WHERE state.format = 'POINTS'
            AND points.season_id = ${season.seasonId}
            AND points.tournament_id = state.tournament_id
            AND points.event_id <= state.event_id
            AND points.updated_at > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT battle.updated_at AS source_updated_at
          FROM competition.tournament_battle_group_results battle
          WHERE state.format = 'H2H'
            AND battle.season_id = ${season.seasonId}
            AND battle.tournament_id = state.tournament_id
            AND battle.event_id <= state.event_id
            AND battle.updated_at > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT GREATEST(
                   result.updated_at,
                   COALESCE(result.rich_synced_at, '-infinity'::timestamptz)
                 ) AS source_updated_at
          FROM competition.entry_event_results result
          JOIN competition.tournament_entries roster
            ON roster.season_id = result.season_id
           AND roster.entry_id = result.entry_id
           AND roster.tournament_id = state.tournament_id
          WHERE state.format = 'KNOCKOUT'
            AND result.season_id = ${season.seasonId}
            AND result.event_id = state.event_id
            AND GREATEST(
              result.updated_at,
              COALESCE(result.rich_synced_at, '-infinity'::timestamptz)
            ) > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT knockout.updated_at AS source_updated_at
          FROM competition.tournament_knockout_results knockout
          WHERE state.format = 'KNOCKOUT'
            AND knockout.season_id = ${season.seasonId}
            AND knockout.tournament_id = state.tournament_id
            AND knockout.event_id = state.event_id
            AND knockout.updated_at > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT bracket.updated_at AS source_updated_at
          FROM competition.tournament_knockouts bracket
          WHERE state.format = 'KNOCKOUT'
            AND bracket.season_id = ${season.seasonId}
            AND bracket.tournament_id = state.tournament_id
            AND bracket.started_event_id <= state.event_id
            AND (bracket.ended_event_id IS NULL OR bracket.ended_event_id >= state.event_id)
            AND bracket.updated_at > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
        ) visible_sources
      ) source ON true
      WHERE state.format IS NOT NULL
    ), valid_candidates AS (
      SELECT tournament_id, event_id, format, eligible_at
      FROM candidates
    ), stored_scopes AS (
      SELECT tournament_id, event_id
      FROM competition.tournament_review_heads
      WHERE season_id = ${season.seasonId}
      UNION
      SELECT tournament_id, event_id
      FROM competition.tournament_review_obligations
      WHERE season_id = ${season.seasonId}
    ), stale_scopes AS (
      SELECT stored.tournament_id, stored.event_id
      FROM stored_scopes stored
      LEFT JOIN valid_candidates candidate
        ON candidate.tournament_id = stored.tournament_id
       AND candidate.event_id = stored.event_id
      WHERE candidate.tournament_id IS NULL
    ), locked_stale_scopes AS MATERIALIZED (
      -- Scope locks were acquired in the preceding statement of this
      -- transaction, before this deletion snapshot was established.
      SELECT stale.tournament_id,
             stale.event_id
      FROM stale_scopes stale
    ), retired_heads AS (
      DELETE FROM competition.tournament_review_heads head
      USING locked_stale_scopes stale
      WHERE head.season_id = ${season.seasonId}
        AND head.tournament_id = stale.tournament_id
        AND head.event_id = stale.event_id
      RETURNING head.tournament_id, head.event_id
    ), retired_obligations AS (
      DELETE FROM competition.tournament_review_obligations obligation
      USING locked_stale_scopes stale
      WHERE obligation.season_id = ${season.seasonId}
        AND obligation.tournament_id = stale.tournament_id
        AND obligation.event_id = stale.event_id
      RETURNING obligation.tournament_id, obligation.event_id
    ), upserted AS (
    INSERT INTO competition.tournament_review_obligations
      (season_id, tournament_id, event_id, format, state, eligible_at, next_attempt_at)
    SELECT ${season.seasonId}, tournament_id, event_id, format, 'PENDING', eligible_at,
           GREATEST(eligible_at, ${now.toISOString()}::timestamptz)
    FROM valid_candidates
    ON CONFLICT (season_id, tournament_id, event_id) DO UPDATE
    SET format = EXCLUDED.format,
        state = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN 'PENDING'
          ELSE competition.tournament_review_obligations.state
        END,
        eligible_at = GREATEST(
          competition.tournament_review_obligations.eligible_at,
          EXCLUDED.eligible_at
        ),
        next_attempt_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN GREATEST(EXCLUDED.eligible_at, ${now.toISOString()}::timestamptz)
          ELSE COALESCE(
            competition.tournament_review_obligations.next_attempt_at,
            EXCLUDED.next_attempt_at
          )
        END,
        execution_attempts = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN 0
          ELSE competition.tournament_review_obligations.execution_attempts
        END,
        source_rechecks = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN 0
          ELSE competition.tournament_review_obligations.source_rechecks
        END,
        lease_owner = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.lease_owner
        END,
        lease_expires_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.lease_expires_at
        END,
        first_attempt_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.first_attempt_at
        END,
        last_attempt_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.last_attempt_at
        END,
        ready_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.ready_at
        END,
        degraded_at = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.degraded_at
        END,
        ready_revision = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.ready_revision
        END,
        last_error_code = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.last_error_code
        END,
        last_failure_fingerprint = CASE
          WHEN competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
            OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            THEN NULL
          ELSE competition.tournament_review_obligations.last_failure_fingerprint
        END,
        updated_at = clock_timestamp()
    WHERE competition.tournament_review_obligations.state <> 'PROCESSING'
      AND (
        competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
        OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
      )
    RETURNING tournament_id, event_id
    )
    SELECT (SELECT count(*) FROM upserted)::integer AS upserted_count,
           (SELECT count(*) FROM retired_heads)::integer AS retired_head_count,
           (SELECT count(*) FROM retired_obligations)::integer AS retired_obligation_count
  `;
  });
  const counts = rows[0];
  return (
    Number(counts?.upserted_count ?? 0) +
    Number(counts?.retired_head_count ?? 0) +
    Number(counts?.retired_obligation_count ?? 0)
  );
}

type ClaimedReviewObligation = {
  season_id: number;
  tournament_id: number;
  event_id: number;
  format: TournamentReviewFormat;
  eligible_at: Date | string;
  execution_attempts: number;
  source_rechecks: number;
};

async function claimTournamentReviewObligations(
  season: FplSeasonRef,
  now: Date,
  limit: number,
): Promise<{ owner: string; rows: ClaimedReviewObligation[] }> {
  const owner = randomUUID();
  const db = await getDbClient();
  const rows = await db.begin(
    async (tx) =>
      tx<ClaimedReviewObligation[]>`
      WITH candidates AS (
        SELECT season_id, tournament_id, event_id
        FROM competition.tournament_review_obligations
        WHERE season_id = ${season.seasonId}
          AND (
            (state IN ('PENDING', 'WAITING_SOURCE', 'DEGRADED')
              AND next_attempt_at IS NOT NULL AND next_attempt_at <= ${now.toISOString()}::timestamptz)
            OR (state = 'PROCESSING' AND lease_expires_at < ${now.toISOString()}::timestamptz)
          )
        ORDER BY next_attempt_at NULLS FIRST, event_id, tournament_id
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}
      )
      UPDATE competition.tournament_review_obligations obligation
      SET state = 'PROCESSING',
          lease_owner = ${owner},
          lease_expires_at = ${new Date(now.getTime() + 2 * 60_000).toISOString()}::timestamptz,
          first_attempt_at = COALESCE(first_attempt_at, clock_timestamp()),
          last_attempt_at = clock_timestamp(),
          updated_at = clock_timestamp()
      FROM candidates
      WHERE obligation.season_id = candidates.season_id
        AND obligation.tournament_id = candidates.tournament_id
        AND obligation.event_id = candidates.event_id
      RETURNING obligation.season_id, obligation.tournament_id, obligation.event_id,
                obligation.format, obligation.eligible_at,
                obligation.execution_attempts, obligation.source_rechecks
    `,
  );
  return { owner, rows };
}

async function finishReviewObligation(
  owner: string,
  obligation: ClaimedReviewObligation,
  result: TournamentReviewPublicationResult,
): Promise<void> {
  const db = await getDbClient();
  await db`
    UPDATE competition.tournament_review_obligations
    SET state = 'READY', ready_revision = ${result.revision}, ready_at = clock_timestamp(),
        next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
        last_error_code = NULL, last_failure_fingerprint = NULL, updated_at = clock_timestamp()
    WHERE season_id = ${obligation.season_id}
      AND tournament_id = ${obligation.tournament_id}
      AND event_id = ${obligation.event_id}
      AND state = 'PROCESSING' AND lease_owner = ${owner}
  `;
}

async function failReviewObligation(
  owner: string,
  obligation: ClaimedReviewObligation,
  error: unknown,
): Promise<void> {
  const sourceFailure = error instanceof TournamentReviewSourceNotReadyError;
  const failureNumber = sourceFailure
    ? obligation.source_rechecks + 1
    : obligation.execution_attempts + 1;
  const delay = tournamentReviewRetryDelayMs(sourceFailure ? 'source' : 'execution', failureNumber);
  const now = new Date();
  const eligibleAt = asDate(obligation.eligible_at) ?? now;
  const horizon = new Date(eligibleAt.getTime() + 24 * 60 * 60_000);
  const degraded = delay === null;
  const nextAt = degraded
    ? now.getTime() >= horizon.getTime()
      ? null
      : new Date(Math.min(now.getTime() + 15 * 60_000, horizon.getTime()))
    : new Date(now.getTime() + delay);
  const state: TournamentReviewObligationState = sourceFailure
    ? degraded
      ? 'DEGRADED'
      : 'WAITING_SOURCE'
    : degraded
      ? 'DEGRADED'
      : 'PENDING';
  const code = sourceFailure
    ? 'TOURNAMENT_REVIEW_SOURCE_NOT_READY'
    : 'TOURNAMENT_REVIEW_PUBLISH_FAILED';
  const fingerprint = reviewFingerprint(
    code,
    `${obligation.tournament_id}:${obligation.event_id}:${failureNumber}`,
  );
  const db = await getDbClient();
  await db`
    UPDATE competition.tournament_review_obligations
    SET state = ${state},
        next_attempt_at = ${nextAt?.toISOString() ?? null}::timestamptz,
        execution_attempts = execution_attempts + ${sourceFailure ? 0 : 1},
        source_rechecks = source_rechecks + ${sourceFailure ? 1 : 0},
        degraded_at = CASE WHEN ${degraded} THEN COALESCE(degraded_at, clock_timestamp()) ELSE degraded_at END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${code},
        last_failure_fingerprint = ${fingerprint},
        updated_at = clock_timestamp()
    WHERE season_id = ${obligation.season_id}
      AND tournament_id = ${obligation.tournament_id}
      AND event_id = ${obligation.event_id}
      AND state = 'PROCESSING' AND lease_owner = ${owner}
  `;
  logError('Tournament review obligation failed', error, {
    seasonId: obligation.season_id,
    tournamentId: obligation.tournament_id,
    eventId: obligation.event_id,
    code,
    state,
    nextAttemptAt: nextAt?.toISOString() ?? null,
  });
}

export async function processTournamentReviewObligations(
  season: FplSeasonRef,
  options: { now?: Date; limit?: number } = {},
): Promise<{ reconciled: number; claimed: number; published: number; failed: number }> {
  const now = options.now ?? new Date();
  const reconciled = await reconcileTournamentReviewObligations(season, now);
  const claimed = await claimTournamentReviewObligations(season, now, options.limit ?? 20);
  let published = 0;
  let failed = 0;
  for (const obligation of claimed.rows) {
    try {
      const result = await publishTournamentReviewScope(
        season,
        obligation.tournament_id,
        obligation.event_id,
      );
      await finishReviewObligation(claimed.owner, obligation, result);
      published += 1;
    } catch (error) {
      failed += 1;
      await failReviewObligation(claimed.owner, obligation, error);
    }
  }
  return { reconciled, claimed: claimed.rows.length, published, failed };
}

export type TournamentReviewV2OperationalStatus = Readonly<{
  schemaVersion: typeof TOURNAMENT_REVIEW_SCHEMA_VERSION;
  metricVersion: typeof TOURNAMENT_REVIEW_METRIC_VERSION;
  season: string;
  checkedAt: string;
  eligibleCount: number;
  stateCounts: Readonly<{
    pending: number;
    waitingSource: number;
    processing: number;
    ready: number;
    degraded: number;
  }>;
  publication: Readonly<{
    readyWithCoherentHead: number;
    readyWithIncoherentHead: number;
  }>;
  oldestPendingEligibleAt: string | null;
  latestUpdatedAt: string | null;
  watch: Readonly<{
    tournamentId: number;
    scopes: ReadonlyArray<
      Readonly<{
        eventId: number;
        format: TournamentReviewFormat;
        state: TournamentReviewObligationState;
        eligibleAt: string;
        nextAttemptAt: string | null;
        revision: number | null;
        publishedAt: string | null;
        eventDataCheckedAt: string | null;
        sourceMaxCheckedAt: string | null;
        updatedAt: string;
        lastErrorCode: string | null;
      }>
    >;
  } | null>;
}>;

type TournamentReviewOperationalAggregateRow = {
  eligible_count: number | string;
  pending_count: number | string;
  waiting_source_count: number | string;
  processing_count: number | string;
  ready_count: number | string;
  degraded_count: number | string;
  ready_coherent_count: number | string;
  ready_incoherent_count: number | string;
  oldest_pending_eligible_at: Date | string | null;
  latest_updated_at: Date | string | null;
};

type TournamentReviewOperationalWatchRow = {
  tournament_id: number;
  event_id: number;
  format: TournamentReviewFormat;
  state: TournamentReviewObligationState;
  eligible_at: Date | string;
  next_attempt_at: Date | string | null;
  ready_revision: number | string | null;
  published_at: Date | string | null;
  event_data_checked_at: Date | string | null;
  source_max_checked_at: Date | string | null;
  updated_at: Date | string;
  last_error_code: string | null;
};

/**
 * Bounded, read-only operational evidence for the V2 publication lane.
 * Identifiers and failure codes are intentionally limited to a caller-supplied
 * tournament watch; raw provider errors and payloads never leave the Data
 * process. The aggregate is consumed by the VPS probe through /jobs/status.
 */
export async function getTournamentReviewV2OperationalStatus(
  season: FplSeasonRef,
  watchTournamentId?: number,
  now = new Date(),
): Promise<TournamentReviewV2OperationalStatus> {
  const db = await getDbClient();
  const aggregateRows = await db<TournamentReviewOperationalAggregateRow[]>`
      SELECT count(*)::integer AS eligible_count,
             count(*) FILTER (WHERE state = 'PENDING')::integer AS pending_count,
             count(*) FILTER (WHERE state = 'WAITING_SOURCE')::integer AS waiting_source_count,
             count(*) FILTER (WHERE state = 'PROCESSING')::integer AS processing_count,
             count(*) FILTER (WHERE state = 'READY')::integer AS ready_count,
             count(*) FILTER (WHERE state = 'DEGRADED')::integer AS degraded_count,
             count(*) FILTER (
               WHERE state = 'READY'
                 AND ready_revision IS NOT NULL
                 AND head.revision = ready_revision
                 AND head.content_sha256 = publication.content_sha256
             )::integer AS ready_coherent_count,
             count(*) FILTER (
               WHERE state = 'READY'
                 AND (
                   ready_revision IS NULL
                   OR head.revision IS NULL
                   OR publication.revision IS NULL
                   OR head.revision <> ready_revision
                   OR head.content_sha256 <> publication.content_sha256
                 )
             )::integer AS ready_incoherent_count,
             min(eligible_at) FILTER (WHERE state <> 'READY') AS oldest_pending_eligible_at,
             max(obligation.updated_at) AS latest_updated_at
      FROM competition.tournament_review_obligations obligation
      LEFT JOIN competition.tournament_review_heads head
        ON head.season_id = obligation.season_id
       AND head.tournament_id = obligation.tournament_id
       AND head.event_id = obligation.event_id
      LEFT JOIN competition.tournament_review_publications publication
        ON publication.season_id = obligation.season_id
       AND publication.tournament_id = obligation.tournament_id
       AND publication.event_id = obligation.event_id
       AND publication.revision = obligation.ready_revision
      WHERE obligation.season_id = ${season.seasonId}
    `;
  const normalizedWatchTournamentId =
    Number.isInteger(watchTournamentId) && (watchTournamentId ?? 0) > 0 ? watchTournamentId : null;
  const watchRows = normalizedWatchTournamentId
    ? await db<TournamentReviewOperationalWatchRow[]>`
        SELECT obligation.tournament_id,
               obligation.event_id,
               obligation.format,
               obligation.state,
               obligation.eligible_at,
               obligation.next_attempt_at,
               obligation.ready_revision,
               publication.published_at,
               publication.event_data_checked_at,
               publication.source_max_checked_at,
               obligation.updated_at,
               obligation.last_error_code
        FROM competition.tournament_review_obligations obligation
        LEFT JOIN competition.tournament_review_publications publication
          ON publication.season_id = obligation.season_id
         AND publication.tournament_id = obligation.tournament_id
         AND publication.event_id = obligation.event_id
         AND publication.revision = obligation.ready_revision
        WHERE obligation.season_id = ${season.seasonId}
          AND obligation.tournament_id = ${normalizedWatchTournamentId}
        ORDER BY obligation.event_id DESC
        LIMIT 38
      `
    : [];
  const aggregate = aggregateRows[0];
  const count = (value: number | string | null | undefined): number => {
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  };
  const watch = watchRows.length
    ? {
        tournamentId: watchRows[0].tournament_id,
        scopes: watchRows.map((row) => ({
          eventId: row.event_id,
          format: row.format,
          state: row.state,
          eligibleAt: dateIso(row.eligible_at) ?? now.toISOString(),
          nextAttemptAt: dateIso(row.next_attempt_at),
          revision: integerOrNull(row.ready_revision),
          publishedAt: dateIso(row.published_at),
          eventDataCheckedAt: dateIso(row.event_data_checked_at),
          sourceMaxCheckedAt: dateIso(row.source_max_checked_at),
          updatedAt: dateIso(row.updated_at) ?? now.toISOString(),
          lastErrorCode: row.last_error_code,
        })),
      }
    : null;
  return {
    schemaVersion: TOURNAMENT_REVIEW_SCHEMA_VERSION,
    metricVersion: TOURNAMENT_REVIEW_METRIC_VERSION,
    season: season.seasonCode,
    checkedAt: now.toISOString(),
    eligibleCount: count(aggregate?.eligible_count),
    stateCounts: {
      pending: count(aggregate?.pending_count),
      waitingSource: count(aggregate?.waiting_source_count),
      processing: count(aggregate?.processing_count),
      ready: count(aggregate?.ready_count),
      degraded: count(aggregate?.degraded_count),
    },
    publication: {
      readyWithCoherentHead: count(aggregate?.ready_coherent_count),
      readyWithIncoherentHead: count(aggregate?.ready_incoherent_count),
    },
    oldestPendingEligibleAt: dateIso(aggregate?.oldest_pending_eligible_at),
    latestUpdatedAt: dateIso(aggregate?.latest_updated_at),
    watch,
  };
}

export function tournamentReviewFailureFingerprint(code: string, bucket: string): string {
  return reviewFingerprint(code, bucket);
}
