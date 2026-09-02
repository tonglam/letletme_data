import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import { getDbClient, withDatabaseTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { GroupMode, KnockoutMode, LeagueType } from '../domain/tournament';
import { setupIssueKey, type TournamentSetupIssueInput } from '../domain/tournament-setup-issue';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { postgresJsonbCanonicalJson } from '../utils/content-hash';
import { logError, logInfo } from '../utils/logger';

/** Hard-cut review contract.  V1 is deliberately not accepted by the
 * current-season writer or by downstream readers. */
export const TOURNAMENT_REVIEW_SCHEMA_VERSION = 'my-tournament-review-v2.1';
export const TOURNAMENT_REVIEW_METRIC_VERSION = 'settled-review-v2';
const TOURNAMENT_REVIEW_REACTIVATION_REASON =
  'scope reactivated after temporary review-window retirement';
const TOURNAMENT_REVIEW_SEMANTIC_VERIFY_BATCH_SIZE = 100;

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

export type TournamentReviewCorrection = Readonly<{
  mode: 'CORRECTION';
  reason: string;
  changeId: string;
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  tournament_updated_at: Date | string;
};

type EventRow = {
  event_id: number;
  event_name: string;
  finished: boolean;
  data_checked: boolean;
  data_checked_at: Date | string | null;
  updated_at: Date | string;
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
 * attempts; after the bounded fast path the obligation keeps its active state
 * and is repaired on the 15-minute cadence until its 24-hour horizon. Only
 * after that horizon does it enter DEGRADED and continue hourly. */
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

function sourceSpan(
  timestamps: Array<Date | string | null | undefined>,
  eventDataCheckedAt: Date,
): {
  sourceMin: Date;
  sourceMax: Date;
} {
  const dates = timestamps.map(asDate).filter((date): date is Date => date !== null);
  if (dates.length === 0)
    throw new TournamentReviewSourceNotReadyError('review source provenance is missing');
  const sourceMax = dates.reduce(
    (max, date) => (date.getTime() > max.getTime() ? date : max),
    dates[0],
  );
  // The review publication contract treats the finalized event checkpoint as
  // the lower freshness fence. Historical/static inputs may legitimately have
  // older timestamps, while current event sources are independently checked
  // against this checkpoint before a payload is built. Keep the persisted
  // source_min field at the event fence so Data's existing database constraint
  // and GraphQL's consumer validator describe the same interval.
  const sourceMin = eventDataCheckedAt;
  if (sourceMin.getTime() > sourceMax.getTime()) {
    throw new TournamentReviewSourceNotReadyError(
      'review source provenance is before event checkpoint',
    );
  }
  return { sourceMin, sourceMax };
}

export function tournamentReviewSourceSpan(
  eventDataCheckedAt: Date | string,
  timestamps: Array<Date | string | null | undefined>,
): { sourceMin: Date; sourceMax: Date } {
  const checkpoint = asDate(eventDataCheckedAt);
  if (!checkpoint) {
    throw new TournamentReviewSourceNotReadyError('review event checkpoint is invalid');
  }
  return sourceSpan(timestamps, checkpoint);
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
      // The structural review window is part of the immutable input. Keeping
      // it in the payload lets reconciliation detect a setup correction even
      // when the human-facing tournament header is unchanged.
      groupMode: tournament.group_mode,
      groupStartedEventId: tournament.group_started_event_id,
      groupEndedEventId: tournament.group_ended_event_id,
      knockoutMode: tournament.knockout_mode,
      knockoutStartedEventId: tournament.knockout_started_event_id,
      knockoutEndedEventId: tournament.knockout_ended_event_id,
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

/** Canonical business identity for an immutable review.  Observation,
 * fetch/update and publication clocks are operational evidence, never
 * content identity; excluding them makes repeated scheduler polls no-ops. */
function stripReviewOperationalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReviewOperationalMetadata);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const stripped: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (
        key === 'freshness' ||
        key === 'observation' ||
        key === 'observedAt' ||
        key === 'lastObservedAt' ||
        key === 'publishedAt' ||
        key === 'updatedAt' ||
        key === 'createdAt'
      ) {
        continue;
      }
      stripped[key] = stripReviewOperationalMetadata(record[key]);
    }
    return stripped;
  }
  return value;
}

export function tournamentReviewSemanticSha256(
  payload: unknown,
  orderedChunkHashes: readonly string[] = [],
): string {
  return createHash('sha256')
    .update(
      `${postgresJsonbCanonicalJson(stripReviewOperationalMetadata(payload))}\n${orderedChunkHashes.join('\n')}`,
      'utf8',
    )
    .digest('hex');
}

type ReviewChunk = Readonly<{
  sectionKey: string;
  chunkIndex: number;
  items: unknown[];
  itemCount: number;
  chunkSha256: string;
}>;

type ReviewPublicationManifest = Readonly<{
  sectionCount: number;
  chunkCount: number;
  sections: ReadonlyArray<{
    sectionKey: string;
    itemCount: number;
    chunkCount: number;
    chunkHashes: ReadonlyArray<string>;
    // Preserve the producer's exact boundaries. GraphQL section-page cache
    // witnesses use these counts to derive a trusted row offset; recomputing
    // fixed-width 100-row boundaries would be incorrect for short chunks.
    chunkItemCounts: ReadonlyArray<number>;
  }>;
}>;

function reviewPublicationManifest(chunks: ReadonlyArray<ReviewChunk>): ReviewPublicationManifest {
  const sections = new Map<string, ReviewChunk[]>();
  for (const chunk of chunks) {
    const section = sections.get(chunk.sectionKey) ?? [];
    section.push(chunk);
    sections.set(chunk.sectionKey, section);
  }
  return {
    sectionCount: sections.size,
    chunkCount: chunks.length,
    sections: [...sections.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sectionKey, sectionChunks]) => ({
        sectionKey,
        itemCount: sectionChunks.reduce((total, chunk) => total + chunk.itemCount, 0),
        chunkCount: sectionChunks.length,
        chunkHashes: sectionChunks
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
          .map((chunk) => chunk.chunkSha256),
        chunkItemCounts: sectionChunks
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
          .map((chunk) => chunk.itemCount),
      })),
  };
}

/** Split the immutable sections into bounded rows.  Empty sections still get
 * one zero-item chunk so the manifest can prove that the section was checked
 * and intentionally contains no rows. */
export function splitTournamentReviewChunks(payload: JsonRecord): ReadonlyArray<ReviewChunk> {
  const sections: Array<[string, unknown]> = [];
  const format = payload.format;
  if (format === 'POINTS' && isRecord(payload.points)) {
    sections.push(['POINTS_STANDINGS', payload.points.rows]);
    sections.push([
      'POINTS_TRAJECTORIES',
      Array.isArray(payload.points.trajectoryRows)
        ? payload.points.trajectoryRows
        : payload.points.rows,
    ]);
  } else if (format === 'H2H' && isRecord(payload.h2h)) {
    sections.push(['H2H_FIXTURES', payload.h2h.matches]);
    sections.push(['H2H_STANDINGS', payload.h2h.standings]);
  } else if (format === 'KNOCKOUT' && isRecord(payload.knockout)) {
    sections.push(['KNOCKOUT_BRACKET', payload.knockout.matches]);
  }
  const chunks: ReviewChunk[] = [];
  for (const [sectionKey, raw] of sections) {
    const items = Array.isArray(raw) ? raw : [];
    if (items.length === 0) {
      chunks.push({
        sectionKey,
        chunkIndex: 0,
        items: [],
        itemCount: 0,
        chunkSha256: createHash('sha256')
          .update(postgresJsonbCanonicalJson([]), 'utf8')
          .digest('hex'),
      });
      continue;
    }
    for (let offset = 0, chunkIndex = 0; offset < items.length; offset += 100, chunkIndex += 1) {
      const slice = items.slice(offset, offset + 100);
      chunks.push({
        sectionKey,
        chunkIndex,
        items: slice,
        itemCount: slice.length,
        chunkSha256: createHash('sha256')
          .update(postgresJsonbCanonicalJson(slice), 'utf8')
          .digest('hex'),
      });
    }
  }
  return chunks;
}

/**
 * Reuse a READY publication only when its complete sibling set is present and
 * every stored descriptor still matches the payload-derived chunk.  A missing
 * or tampered chunk therefore fails closed and re-enters the normal publish /
 * repair path instead of being reported as a successful no-op.
 */
function reviewChunksMatchPayload(
  payload: JsonRecord | null | undefined,
  rows: ReadonlyArray<{
    section_key: string;
    chunk_index: number | string;
    item_count: number | string;
    chunk_sha256: string;
    items: unknown;
  }>,
): boolean {
  if (!payload) return false;
  const manifest = isRecord(payload.manifest) ? payload.manifest : null;
  const descriptors = manifest && Array.isArray(manifest.sections) ? manifest.sections : null;
  if (!manifest || !descriptors) return false;
  const sectionCount = Number(manifest.sectionCount);
  const chunkCount = Number(manifest.chunkCount);
  if (
    !Number.isSafeInteger(sectionCount) ||
    sectionCount < 0 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 0 ||
    descriptors.length !== sectionCount
  ) {
    return false;
  }
  const expected = [] as Array<{
    sectionKey: string;
    chunkIndex: number;
    itemCount: number;
    chunkSha256: string;
  }>;
  const sectionKeys = new Set<string>();
  for (const section of descriptors) {
    if (
      !isRecord(section) ||
      typeof section.sectionKey !== 'string' ||
      section.sectionKey.length === 0 ||
      sectionKeys.has(section.sectionKey) ||
      !Array.isArray(section.chunkHashes) ||
      !Array.isArray(section.chunkItemCounts)
    ) {
      return false;
    }
    const itemCount = Number(section.itemCount);
    const declaredChunkCount = Number(section.chunkCount);
    const hashes = section.chunkHashes;
    const itemCounts = section.chunkItemCounts;
    if (
      !Number.isSafeInteger(itemCount) ||
      itemCount < 0 ||
      !Number.isSafeInteger(declaredChunkCount) ||
      declaredChunkCount !== hashes.length ||
      declaredChunkCount !== itemCounts.length ||
      itemCounts.some(
        (count) => !Number.isSafeInteger(Number(count)) || Number(count) < 0 || Number(count) > 100,
      ) ||
      (itemCount === 0 && (declaredChunkCount !== 1 || Number(itemCounts[0]) !== 0)) ||
      (itemCount > 0 &&
        (declaredChunkCount < 1 ||
          itemCounts.some((count) => Number(count) <= 0) ||
          itemCounts.reduce((total, count) => total + Number(count), 0) !== itemCount)) ||
      !hashes.every(
        (chunkSha256): chunkSha256 is string =>
          typeof chunkSha256 === 'string' && /^[0-9a-f]{64}$/.test(chunkSha256),
      )
    ) {
      return false;
    }
    const sectionKey = section.sectionKey;
    sectionKeys.add(sectionKey);
    hashes.forEach((chunkSha256, chunkIndex) => {
      expected.push({
        sectionKey,
        chunkIndex,
        itemCount: Number(itemCounts[chunkIndex]),
        chunkSha256,
      });
    });
  }
  if (expected.length !== rows.length || expected.length !== chunkCount) return false;
  const expectedKeys = new Set(expected.map((chunk) => `${chunk.sectionKey}:${chunk.chunkIndex}`));
  const actual = new Map(rows.map((row) => [`${row.section_key}:${Number(row.chunk_index)}`, row]));
  if (actual.size !== rows.length) return false;
  if (
    [...actual.keys()].some((key) => !expectedKeys.has(key)) ||
    [...expectedKeys].some((key) => !actual.has(key))
  ) {
    return false;
  }
  return (
    expected.every((chunk) => {
      const row = actual.get(`${chunk.sectionKey}:${chunk.chunkIndex}`);
      const storedItems = row?.items;
      const storedItemsSha = Array.isArray(storedItems)
        ? createHash('sha256').update(postgresJsonbCanonicalJson(storedItems), 'utf8').digest('hex')
        : null;
      return Boolean(
        row &&
          Number.isInteger(chunk.itemCount) &&
          chunk.itemCount >= 0 &&
          chunk.itemCount <= 100 &&
          Number(row.item_count) === chunk.itemCount &&
          row.chunk_sha256 === chunk.chunkSha256 &&
          storedItemsSha === chunk.chunkSha256 &&
          Array.isArray(storedItems) &&
          storedItems.length === chunk.itemCount,
      );
    }) &&
    [...sectionKeys].every((sectionKey) => {
      const descriptor = descriptors.find(
        (candidate) => isRecord(candidate) && candidate.sectionKey === sectionKey,
      );
      if (!descriptor || !isRecord(descriptor)) return false;
      const itemCount = Number(descriptor.itemCount);
      const sectionRows = rows.filter((row) => row.section_key === sectionKey);
      return (
        sectionRows.length === Number(descriptor.chunkCount) &&
        sectionRows.reduce((total, row) => total + Number(row.item_count), 0) === itemCount
      );
    })
  );
}

function orderedReviewChunkHashes(
  rows: ReadonlyArray<{ section_key: string; chunk_index: number | string; chunk_sha256: string }>,
): string[] {
  return [...rows]
    .sort(
      (left, right) =>
        left.section_key.localeCompare(right.section_key) ||
        Number(left.chunk_index) - Number(right.chunk_index),
    )
    .map((row) => row.chunk_sha256);
}

/** Remove large row arrays from the publication identity.  The immutable
 * siblings are the sole row representation; this JSON keeps only the
 * aggregate/header shell plus the exact section manifest. */
function reviewPublicationManifestPayload(
  payload: JsonRecord,
  manifest: ReviewPublicationManifest,
): JsonRecord {
  const output: JsonRecord = { ...payload, manifest };
  if (payload.format === 'POINTS' && isRecord(payload.points)) {
    const { rows: _rows, trajectoryRows: _trajectoryRows, ...points } = payload.points;
    output.points = points;
  } else if (payload.format === 'H2H' && isRecord(payload.h2h)) {
    const { matches: _matches, standings: _standings, ...h2h } = payload.h2h;
    output.h2h = h2h;
  } else if (payload.format === 'KNOCKOUT' && isRecord(payload.knockout)) {
    const { matches: _matches, ...knockout } = payload.knockout;
    output.knockout = knockout;
  }
  return output;
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
  result_updated_at: Date | string | null;
  event_rank: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  rich_synced_at: Date | string | null;
  group_id: number | null;
  event_group_rank: number | null;
  group_event_points: number | null;
  group_event_cost: number | null;
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
  previous_group_updated_at: Date | string | null;
  history_group_mismatch_count: number | string | null;
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
           result.updated_at AS result_updated_at,
           result.event_rank,
           result.overall_points,
           result.overall_rank,
           result.rich_synced_at,
           group_result.group_id,
           group_result.event_group_rank,
           group_result.event_points AS group_event_points,
           group_result.event_cost AS group_event_cost,
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
             JOIN fpl.events previous_event
               ON previous_event.season_id = previous.season_id
              AND previous_event.event_id = previous.event_id
             WHERE previous.season_id = roster.season_id
               AND previous.tournament_id = roster.tournament_id
               AND previous.entry_id = roster.entry_id
               AND previous.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND previous.event_id < ${event.event_id}
               AND previous_event.finished = true
               AND previous_event.data_checked = true
               AND previous_event.data_checked_at IS NOT NULL
             ORDER BY previous.event_id DESC
             LIMIT 1
           ) AS previous_group_rank,
           (
             SELECT previous.updated_at
             FROM competition.tournament_points_group_results previous
             JOIN fpl.events previous_event
               ON previous_event.season_id = previous.season_id
              AND previous_event.event_id = previous.event_id
             WHERE previous.season_id = roster.season_id
               AND previous.tournament_id = roster.tournament_id
               AND previous.entry_id = roster.entry_id
               AND previous.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND previous.event_id < ${event.event_id}
               AND previous_event.finished = true
               AND previous_event.data_checked = true
               AND previous_event.data_checked_at IS NOT NULL
             ORDER BY previous.event_id DESC
             LIMIT 1
           ) AS previous_group_updated_at,
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
           (
             SELECT count(*)::integer
             FROM competition.entry_event_results history_result
             JOIN fpl.events history_event
               ON history_event.season_id = history_result.season_id
              AND history_event.event_id = history_result.event_id
             LEFT JOIN competition.tournament_points_group_results history_group
               ON history_group.season_id = history_result.season_id
              AND history_group.tournament_id = roster.tournament_id
              AND history_group.entry_id = history_result.entry_id
              AND history_group.event_id = history_result.event_id
             WHERE history_result.season_id = roster.season_id
               AND history_result.entry_id = roster.entry_id
               AND history_result.event_id >= GREATEST(
                 COALESCE(tournament.group_started_event_id, 1),
                 COALESCE(entry.started_event, 1)
               )
               AND history_result.event_id <= ${event.event_id}
               AND history_event.finished = true
               AND history_event.data_checked = true
               AND history_event.data_checked_at IS NOT NULL
               AND history_result.event_points IS NOT NULL
               AND history_result.event_net_points IS NOT NULL
               AND (
                 history_group.event_points IS DISTINCT FROM history_result.event_points
                 OR history_group.event_cost IS DISTINCT FROM history_result.event_transfers_cost
                 OR history_group.event_net_points IS DISTINCT FROM history_result.event_net_points
                 OR history_group.updated_at < GREATEST(
                   history_result.updated_at,
                   COALESCE(history_result.rich_synced_at, '-infinity'::timestamptz),
                   history_event.data_checked_at
                 )
               )
           ) AS history_group_mismatch_count,
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
  const canonicalGroupRows = await tx<Array<{ entry_id: number; group_id: number }>>`
    SELECT entry_id, group_id
    FROM competition.tournament_groups
    WHERE season_id = ${seasonId}
      AND tournament_id = ${tournament.tournament_id}
    ORDER BY entry_id, group_id
  `;
  const observedEntryGroupIds = new Map<number, number>();
  for (const row of rows) {
    if (row.group_id !== null) observedEntryGroupIds.set(row.entry_id, row.group_id);
  }
  if (
    !hasCanonicalTournamentReviewGroupAssignment({
      entryIds: new Set(rows.map((row) => row.entry_id)),
      observedEntryGroupIds,
      canonicalRows: canonicalGroupRows,
    })
  ) {
    throw new TournamentReviewSourceNotReadyError('points group assignment is stale');
  }
  const canonicalGroupByEntry = new Map(
    canonicalGroupRows.map((row) => [row.entry_id, row.group_id]),
  );
  const historicalGroupRows = await tx<Array<{ entry_id: number; group_id: number | null }>>`
    SELECT history.entry_id, history.group_id
    FROM competition.tournament_points_group_results history
    JOIN competition.tournament_entries roster
      ON roster.season_id = history.season_id
     AND roster.tournament_id = history.tournament_id
     AND roster.entry_id = history.entry_id
    JOIN competition.entries entry
      ON entry.season_id = history.season_id
     AND entry.entry_id = history.entry_id
    JOIN fpl.events history_event
      ON history_event.season_id = history.season_id
     AND history_event.event_id = history.event_id
    JOIN competition.tournaments history_tournament
      ON history_tournament.season_id = history.season_id
     AND history_tournament.tournament_id = history.tournament_id
    WHERE history.season_id = ${seasonId}
      AND history.tournament_id = ${tournament.tournament_id}
      AND history.event_id >= GREATEST(
        COALESCE(history_tournament.group_started_event_id, 1),
        COALESCE(entry.started_event, 1)
      )
      AND history.event_id <= ${event.event_id}
      AND history_event.finished = true
      AND history_event.data_checked = true
      AND history_event.data_checked_at IS NOT NULL
  `;
  if (
    historicalGroupRows.some(
      (row) => row.group_id === null || canonicalGroupByEntry.get(row.entry_id) !== row.group_id,
    )
  ) {
    throw new TournamentReviewSourceNotReadyError('historical points group assignment is stale');
  }
  const notApplicable = rows.filter(
    (row) => !isTournamentReviewEntryApplicable(row.started_event, event.event_id),
  );
  const applicable = rows.filter((row) => !notApplicable.includes(row));
  // `previous_group_rank` is a denormalized value.  A corrected
  // entries.started_event changes the effective cumulative window, so the
  // stored rank can remain non-null while no longer describing the last
  // finalized event that this review is allowed to include.  Recompute the
  // expected rank over that same per-entry window and fail closed before the
  // value is copied into the immutable payload.
  const historicalRankRows = await tx<
    Array<{
      entry_id: number;
      event_id: number;
      stored_group_rank: number | null;
      expected_group_rank: number;
    }>
  >`
    WITH finalized_points AS (
      SELECT history.entry_id,
             history.event_id,
             history.group_id,
             history.event_net_points,
             history.event_group_rank AS stored_group_rank,
             result.overall_rank
      FROM competition.tournament_points_group_results history
      JOIN competition.tournament_entries roster
        ON roster.season_id = history.season_id
       AND roster.tournament_id = history.tournament_id
       AND roster.entry_id = history.entry_id
      JOIN competition.entries entry
        ON entry.season_id = history.season_id
       AND entry.entry_id = history.entry_id
      JOIN fpl.events history_event
        ON history_event.season_id = history.season_id
       AND history_event.event_id = history.event_id
      LEFT JOIN competition.entry_event_results result
        ON result.season_id = history.season_id
       AND result.entry_id = history.entry_id
       AND result.event_id = history.event_id
      JOIN competition.tournaments history_tournament
        ON history_tournament.season_id = history.season_id
       AND history_tournament.tournament_id = history.tournament_id
      WHERE history.season_id = ${seasonId}
        AND history.tournament_id = ${tournament.tournament_id}
        AND history.event_id >= GREATEST(
          COALESCE(history_tournament.group_started_event_id, 1),
          COALESCE(entry.started_event, 1)
        )
        AND history.event_id < ${event.event_id}
        AND history_event.finished = true
        AND history_event.data_checked = true
        AND history_event.data_checked_at IS NOT NULL
        AND history.event_net_points IS NOT NULL
    ), cumulative AS (
      SELECT finalized.*,
             SUM(finalized.event_net_points) OVER (
               PARTITION BY finalized.entry_id, finalized.group_id
               ORDER BY finalized.event_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_net_points
      FROM finalized_points finalized
    ), ranked AS (
      SELECT cumulative.entry_id,
             cumulative.event_id,
             cumulative.stored_group_rank,
             RANK() OVER (
               PARTITION BY cumulative.event_id, cumulative.group_id
               ORDER BY cumulative.cumulative_net_points DESC, cumulative.overall_rank NULLS LAST
             )::integer AS expected_group_rank
      FROM cumulative
    )
    SELECT DISTINCT ON (entry_id)
           entry_id,
           event_id,
           stored_group_rank,
           expected_group_rank
    FROM ranked
    ORDER BY entry_id, event_id DESC
  `;
  const historicalRankByEntry = new Map(
    historicalRankRows.map((row) => [row.entry_id, row.expected_group_rank]),
  );
  if (
    applicable.some(
      (row) =>
        integerOrNull(row.previous_group_rank) !==
        (historicalRankByEntry.get(row.entry_id) ?? null),
    )
  ) {
    throw new TournamentReviewSourceNotReadyError('previous points group ranks are stale');
  }
  if (
    applicable.some(
      (row) =>
        row.event_points === null ||
        row.event_cost === null ||
        row.event_net_points === null ||
        row.result_updated_at === null ||
        row.rich_synced_at === null ||
        row.group_id === null ||
        row.event_group_rank === null ||
        row.group_event_points === null ||
        row.group_event_cost === null ||
        row.group_event_net_points === null ||
        row.group_updated_at === null ||
        row.season_expected_event_count === null ||
        row.season_gross_result_count === null ||
        row.season_net_result_count === null ||
        row.history_source_min_checked_at === null ||
        row.history_source_max_checked_at === null ||
        row.season_gross_result_count !== row.season_expected_event_count ||
        row.season_net_result_count !== row.season_expected_event_count ||
        Number(row.history_group_mismatch_count ?? 0) !== 0 ||
        row.group_event_points !== row.event_points ||
        row.group_event_cost !== row.event_cost ||
        row.group_event_net_points !== row.event_net_points ||
        (asDate(row.group_updated_at)?.getTime() ?? 0) <
          Math.max(
            asDate(row.result_updated_at)?.getTime() ?? 0,
            asDate(row.rich_synced_at)?.getTime() ?? 0,
            asDate(event.data_checked_at)?.getTime() ?? 0,
          ),
    )
  ) {
    throw new TournamentReviewSourceNotReadyError(
      'points result or derived group rows are incomplete or inconsistent',
    );
  }
  const sourceTimes: Array<Date | string | null> = rows.flatMap((row) => [
    row.entry_updated_at,
    row.roster_created_at,
  ]);
  sourceTimes.push(
    ...applicable.flatMap((row) => [
      row.rich_synced_at,
      row.result_updated_at,
      row.group_updated_at,
      row.history_source_min_checked_at,
      row.history_source_max_checked_at,
      row.previous_group_updated_at,
    ]),
  );
  const rankFallback = new Map<number, number>();
  const expectedGroupRanks = new Map<number, number>();
  const groupedRows = new Map<number, PointsSourceRow[]>();
  for (const row of applicable) {
    const groupId = row.group_id;
    if (groupId === null) continue;
    const groupRows = groupedRows.get(groupId) ?? [];
    groupRows.push(row);
    groupedRows.set(groupId, groupRows);
  }
  for (const groupRows of groupedRows.values()) {
    let previousKey: string | null = null;
    let rank = 0;
    [...groupRows]
      .sort(
        (left, right) =>
          integer(right.season_net_points) - integer(left.season_net_points) ||
          (left.overall_rank ?? Number.MAX_SAFE_INTEGER) -
            (right.overall_rank ?? Number.MAX_SAFE_INTEGER) ||
          left.entry_id - right.entry_id,
      )
      .forEach((row, index) => {
        const key = `${row.season_net_points}:${row.overall_rank ?? Number.MAX_SAFE_INTEGER}`;
        if (key !== previousKey) rank = index + 1;
        previousKey = key;
        expectedGroupRanks.set(row.entry_id, rank);
      });
  }
  if (applicable.some((row) => row.event_group_rank !== expectedGroupRanks.get(row.entry_id))) {
    throw new TournamentReviewSourceNotReadyError('points group ranks are inconsistent');
  }
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
  // The trajectory section is a deliberate projection of the same frozen
  // roster, ordered by current rank and then rank movement.  It is not a
  // second copy of the roster-order standings section: consumers can render
  // rank movement (previousRank -> rank) without changing the settled values
  // or inventing a second source of truth.
  const trajectoryRows = [...pointRows].sort(
    (left, right) =>
      sortRank(left.rank, right.rank) ||
      sortRank(left.previousRank, right.previousRank) ||
      left.entryId - right.entryId,
  );
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
        trajectoryRows,
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
  home_result_net_points?: number | null;
  home_result_event_rank?: number | null;
  home_result_updated_at?: Date | string | null;
  home_result_rich_synced_at?: Date | string | null;
  away_result_net_points?: number | null;
  away_result_event_rank?: number | null;
  away_result_updated_at?: Date | string | null;
  away_result_rich_synced_at?: Date | string | null;
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
  event_rank: number | null;
  result_updated_at: Date | string | null;
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
           result.event_rank,
           result.updated_at AS result_updated_at,
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

/**
 * The battle result rows are a derived projection.  Compare their observed
 * entry-to-group assignment with the durable tournament_groups roster before
 * treating an H2H event as publishable.  A complete but uniformly shifted
 * projection must fail this check just like a missing or duplicate row.
 */
export function hasCanonicalTournamentReviewGroupAssignment(input: {
  entryIds: ReadonlySet<number>;
  observedEntryGroupIds: ReadonlyMap<number, number>;
  canonicalRows: readonly { entry_id: number; group_id: number }[];
}): boolean {
  if (input.canonicalRows.length !== input.entryIds.size) return false;
  const canonicalEntryGroupIds = new Map<number, number>();
  for (const row of input.canonicalRows) {
    if (!input.entryIds.has(row.entry_id) || canonicalEntryGroupIds.has(row.entry_id)) {
      return false;
    }
    canonicalEntryGroupIds.set(row.entry_id, row.group_id);
  }
  return [...input.entryIds].every(
    (entryId) => canonicalEntryGroupIds.get(entryId) === input.observedEntryGroupIds.get(entryId),
  );
}

export function rankTournamentReviewH2HStandings<
  T extends { entryId: number; matchPoints: number; pointsFor: number; applicable?: boolean },
>(rows: readonly T[]): Array<T & { rank: number | null }> {
  // A late-joining entry is retained in the review roster with an explicit
  // `applicable: false`, but it must not participate in historical standings
  // or consume a competition-rank position. Keep it visible and unranked so
  // consumers can explain the roster count without treating it as a result.
  const applicableRows = rows.filter((row) => row.applicable !== false);
  const ordered = applicableRows.sort(
    (left, right) =>
      right.matchPoints - left.matchPoints ||
      right.pointsFor - left.pointsFor ||
      left.entryId - right.entryId,
  );
  let previousKey: string | null = null;
  let rank = 0;
  const ranked = ordered.map((row, index) => {
    const key = `${row.matchPoints}:${row.pointsFor}`;
    if (key !== previousKey) rank = index + 1;
    previousKey = key;
    return { ...row, rank };
  });
  const unranked = rows
    .filter((row) => row.applicable === false)
    .sort((left, right) => left.entryId - right.entryId)
    .map((row) => ({ ...row, rank: null }));
  return [...ranked, ...unranked];
}

export function isTournamentReviewEntryApplicable(
  startedEvent: number | null,
  eventId: number,
): boolean {
  return startedEvent === null || startedEvent <= eventId;
}

/** H2H match points are derived from the recorded net scores, never trusted
 * independently from the score columns. */
export function h2hMatchPointsMatchScore(
  homeNetPoints: number,
  awayNetPoints: number,
  homeMatchPoints: number,
  awayMatchPoints: number,
): boolean {
  const expectedHome = homeNetPoints > awayNetPoints ? 3 : homeNetPoints < awayNetPoints ? 0 : 1;
  const expectedAway = homeNetPoints > awayNetPoints ? 0 : homeNetPoints < awayNetPoints ? 3 : 1;
  return homeMatchPoints === expectedHome && awayMatchPoints === expectedAway;
}

type TournamentReviewEntryResultEvidence = {
  event_net_points: number | null;
  updated_at: Date | string | null | undefined;
  rich_synced_at: Date | string | null | undefined;
};

/**
 * Derived H2H/knockout rows may be written after the entry result they read.
 * Require both the score value and a row watermark that covers the result
 * watermark before allowing an immutable review publication to use the row.
 */
export function tournamentReviewScoreMatchesEntryResult(
  matchNetPoints: number | null,
  matchSourceCheckedAt: Date | string | null | undefined,
  matchUpdatedAt: Date | string | null | undefined,
  result: TournamentReviewEntryResultEvidence | null | undefined,
): boolean {
  if (!result || matchNetPoints === null || result.event_net_points === null) return false;
  if (matchNetPoints !== result.event_net_points) return false;
  const matchWatermark = Math.max(
    ...[matchSourceCheckedAt, matchUpdatedAt]
      .map(asDate)
      .filter((date): date is Date => date !== null)
      .map((date) => date.getTime()),
  );
  const resultWatermark = Math.max(
    ...[result.updated_at, result.rich_synced_at]
      .map(asDate)
      .filter((date): date is Date => date !== null)
      .map((date) => date.getTime()),
  );
  return (
    Number.isFinite(matchWatermark) &&
    Number.isFinite(resultWatermark) &&
    matchWatermark >= resultWatermark
  );
}

/**
 * Custom knockout rows carry the same deterministic winner contract as the
 * producer: net points first, then goals scored, then goals conceded, and
 * finally the lower entry id. Keeping this calculation in the publication
 * validator prevents a repaired row from smuggling an arbitrary winner into
 * an immutable review snapshot.
 */
function resolveTournamentReviewKnockoutWinner(input: {
  homeEntryId: number | null;
  awayEntryId: number | null;
  homeNetPoints: number;
  awayNetPoints: number;
  homeGoalsScored: number;
  awayGoalsScored: number;
  homeGoalsConceded: number;
  awayGoalsConceded: number;
}): number | null {
  if (input.homeEntryId === null) return input.awayEntryId;
  if (input.awayEntryId === null) return input.homeEntryId;
  if (input.homeNetPoints !== input.awayNetPoints) {
    return input.homeNetPoints > input.awayNetPoints ? input.homeEntryId : input.awayEntryId;
  }
  if (input.homeGoalsScored !== input.awayGoalsScored) {
    return input.homeGoalsScored > input.awayGoalsScored ? input.homeEntryId : input.awayEntryId;
  }
  if (input.homeGoalsConceded !== input.awayGoalsConceded) {
    return input.homeGoalsConceded < input.awayGoalsConceded
      ? input.homeEntryId
      : input.awayEntryId;
  }
  return Math.min(input.homeEntryId, input.awayEntryId);
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
    if (!match.is_bye) {
      if (
        match.home_net_points === null ||
        match.home_match_points === null ||
        match.away_net_points === null ||
        match.away_match_points === null
      ) {
        throw new TournamentReviewSourceNotReadyError('H2H match score is incomplete');
      }
      if (
        !h2hMatchPointsMatchScore(
          match.home_net_points,
          match.away_net_points,
          match.home_match_points,
          match.away_match_points,
        )
      ) {
        throw new TournamentReviewSourceNotReadyError(
          'H2H match points are inconsistent with scores',
        );
      }
      if (
        match.source_order === null &&
        ((home && match.home_rank !== home.event_rank) ||
          (away && match.away_rank !== away.event_rank))
      ) {
        throw new TournamentReviewSourceNotReadyError(
          'Local H2H match ranks do not match entry event results',
        );
      }
      if (
        (match.home_entry_id !== null &&
          !match.home_is_average &&
          !tournamentReviewScoreMatchesEntryResult(
            match.home_net_points,
            match.source_checked_at,
            match.updated_at,
            home
              ? {
                  event_net_points: home.event_net_points,
                  updated_at: home.result_updated_at,
                  rich_synced_at: home.rich_synced_at,
                }
              : null,
          )) ||
        (match.away_entry_id !== null &&
          !match.away_is_average &&
          !tournamentReviewScoreMatchesEntryResult(
            match.away_net_points,
            match.source_checked_at,
            match.updated_at,
            away
              ? {
                  event_net_points: away.event_net_points,
                  updated_at: away.result_updated_at,
                  rich_synced_at: away.rich_synced_at,
                }
              : null,
          ))
      ) {
        throw new TournamentReviewSourceNotReadyError(
          'H2H match scores do not match entry event results',
        );
      }
    }
    const sourceCheckedAt = battleSourceCheckedAt(match);
    if (!sourceCheckedAt) {
      throw new TournamentReviewSourceNotReadyError('H2H match source timestamp is missing');
    }
    if (sourceCheckedAt.getTime() < eventDataCheckedAt.getTime()) {
      throw new TournamentReviewSourceNotReadyError('H2H match source is stale');
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
            applicable: true,
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
              applicable: isTournamentReviewEntryApplicable(home.started_event, event.event_id),
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
            applicable: true,
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
              applicable: isTournamentReviewEntryApplicable(away.started_event, event.event_id),
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

  // Match rows are a derived projection and can be internally consistent
  // while still assigning every entry to the wrong group.  The durable
  // tournament_groups rows are the canonical roster/group assignment, so
  // publication must fence on that assignment before accepting the H2H
  // projection.  Duplicate or missing canonical rows fail closed as well.
  const canonicalGroupRows = await tx<Array<{ entry_id: number; group_id: number }>>`
    SELECT entry_id, group_id
    FROM competition.tournament_groups
    WHERE season_id = ${seasonId}
      AND tournament_id = ${tournament.tournament_id}
    ORDER BY entry_id, group_id
  `;
  if (
    !hasCanonicalTournamentReviewGroupAssignment({
      entryIds: new Set(scores.keys()),
      observedEntryGroupIds: entryGroupIds,
      canonicalRows: canonicalGroupRows,
    })
  ) {
    throw new TournamentReviewSourceNotReadyError('H2H group assignment is stale');
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
           event.data_checked_at AS event_data_checked_at,
           home_result.event_net_points AS home_result_net_points,
           home_result.event_rank AS home_result_event_rank,
           home_result.updated_at AS home_result_updated_at,
           home_result.rich_synced_at AS home_result_rich_synced_at,
           away_result.event_net_points AS away_result_net_points,
           away_result.event_rank AS away_result_event_rank,
           away_result.updated_at AS away_result_updated_at,
           away_result.rich_synced_at AS away_result_rich_synced_at
    FROM competition.tournament_battle_group_results battle
    JOIN fpl.events event
      ON event.season_id = battle.season_id
     AND event.event_id = battle.event_id
    LEFT JOIN competition.entry_event_results home_result
      ON home_result.season_id = battle.season_id
     AND home_result.entry_id = battle.home_entry_id
     AND home_result.event_id = battle.event_id
    LEFT JOIN competition.entry_event_results away_result
      ON away_result.season_id = battle.season_id
     AND away_result.entry_id = battle.away_entry_id
     AND away_result.event_id = battle.event_id
    WHERE battle.season_id = ${seasonId}
      AND battle.tournament_id = ${tournament.tournament_id}
      AND battle.event_id >= COALESCE(${tournament.group_started_event_id}, 1)
      AND battle.event_id <= ${event.event_id}
      AND event.finished = true
      AND event.data_checked = true
      AND event.data_checked_at IS NOT NULL
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
    applicable: boolean;
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
      applicable: isTournamentReviewEntryApplicable(score?.started_event ?? null, event.event_id),
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

    // Backfilled zero-score rows before a late entry joined the tournament
    // remain useful for roster coverage, but they are not played matches.
    // Exclude the whole matchup so the opponent is not awarded a phantom
    // result either, and do not require pre-entry score/rank evidence.
    const homeApplicable =
      match.home_entry_id === null ||
      match.home_is_average ||
      isTournamentReviewEntryApplicable(
        scores.get(match.home_entry_id)?.started_event ?? null,
        match.event_id,
      );
    const awayApplicable =
      match.away_entry_id === null ||
      match.away_is_average ||
      isTournamentReviewEntryApplicable(
        scores.get(match.away_entry_id)?.started_event ?? null,
        match.event_id,
      );
    if (!homeApplicable || !awayApplicable) continue;

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
    if (
      !h2hMatchPointsMatchScore(
        match.home_net_points,
        match.away_net_points,
        match.home_match_points,
        match.away_match_points,
      )
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'H2H history match points are inconsistent with scores',
      );
    }
    if (
      match.source_order === null &&
      ((match.home_entry_id !== null &&
        !match.home_is_average &&
        match.home_rank !== match.home_result_event_rank) ||
        (match.away_entry_id !== null &&
          !match.away_is_average &&
          match.away_rank !== match.away_result_event_rank))
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'Local H2H history ranks do not match entry event results',
      );
    }
    if (
      (match.home_entry_id !== null &&
        !match.home_is_average &&
        !tournamentReviewScoreMatchesEntryResult(
          match.home_net_points,
          match.source_checked_at,
          match.updated_at,
          match.home_result_net_points === undefined
            ? null
            : {
                event_net_points: match.home_result_net_points,
                updated_at: match.home_result_updated_at,
                rich_synced_at: match.home_result_rich_synced_at,
              },
        )) ||
      (match.away_entry_id !== null &&
        !match.away_is_average &&
        !tournamentReviewScoreMatchesEntryResult(
          match.away_net_points,
          match.source_checked_at,
          match.updated_at,
          match.away_result_net_points === undefined
            ? null
            : {
                event_net_points: match.away_result_net_points,
                updated_at: match.away_result_updated_at,
                rich_synced_at: match.away_result_rich_synced_at,
              },
        ))
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'H2H history scores do not match entry event results',
      );
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
  const activeParticipantIds = new Set<number>();
  for (const bracket of brackets) {
    if (bracket.home_entry_id !== null) activeParticipantIds.add(bracket.home_entry_id);
    if (bracket.away_entry_id !== null) activeParticipantIds.add(bracket.away_entry_id);
  }
  const activeEligible = eligible.filter((row) => activeParticipantIds.has(row.entry_id));
  const eventDataCheckedAt = asDate(event.data_checked_at);
  if (!eventDataCheckedAt) {
    throw new TournamentReviewSourceNotReadyError('knockout event data_checked_at is missing');
  }
  // Later rounds retain eliminated teams in the tournament roster. Only the
  // entries present in the active bracket can affect this event's payload and
  // therefore need a finalized score checkpoint.
  requireFreshEntryScores(activeEligible, eventDataCheckedAt, 'knockout');
  const sourceTimes: Array<Date | string | null> = [...scores.values()]
    .filter((row) => activeParticipantIds.has(row.entry_id))
    .flatMap((row) => [row.entry_updated_at, row.roster_created_at]);
  sourceTimes.push(...brackets.map((bracket) => bracket.updated_at));
  sourceTimes.push(...activeEligible.map((row) => row.rich_synced_at));
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
      (match.home_entry_id !== null &&
        !tournamentReviewScoreMatchesEntryResult(
          match.home_net_points,
          match.source_checked_at,
          match.updated_at,
          home
            ? {
                event_net_points: home.event_net_points,
                updated_at: home.result_updated_at,
                rich_synced_at: home.rich_synced_at,
              }
            : null,
        )) ||
      (match.away_entry_id !== null &&
        !tournamentReviewScoreMatchesEntryResult(
          match.away_net_points,
          match.source_checked_at,
          match.updated_at,
          away
            ? {
                event_net_points: away.event_net_points,
                updated_at: away.result_updated_at,
                rich_synced_at: away.rich_synced_at,
              }
            : null,
        ))
    ) {
      throw new TournamentReviewSourceNotReadyError(
        'knockout scores do not match entry event results',
      );
    }
    if (
      match.match_winner !== null &&
      (!scores.has(match.match_winner) ||
        (match.match_winner !== match.home_entry_id && match.match_winner !== match.away_entry_id))
    ) {
      throw new TournamentReviewSourceNotReadyError('knockout winner is outside the match');
    }
    if (match.official_match_id === null) {
      const expectedWinner = resolveTournamentReviewKnockoutWinner({
        homeEntryId: match.home_entry_id,
        awayEntryId: match.away_entry_id,
        homeNetPoints: match.home_net_points ?? 0,
        awayNetPoints: match.away_net_points ?? 0,
        homeGoalsScored: match.home_goals_scored ?? 0,
        awayGoalsScored: match.away_goals_scored ?? 0,
        homeGoalsConceded: match.home_goals_conceded ?? 0,
        awayGoalsConceded: match.away_goals_conceded ?? 0,
      });
      if (expectedWinner !== match.match_winner) {
        throw new TournamentReviewSourceNotReadyError(
          'knockout winner is inconsistent with match totals',
        );
      }
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
            applicable: isTournamentReviewEntryApplicable(home.started_event, event.event_id),
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
            applicable: isTournamentReviewEntryApplicable(away.started_event, event.event_id),
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
           standings_ready_at,
           tournament.updated_at AS tournament_updated_at
    FROM competition.tournaments tournament
    WHERE season_id = ${seasonId} AND tournament_id = ${tournamentId}
    LIMIT 1
  `;
  const events = await tx<EventRow[]>`
    SELECT event_id, name AS event_name, finished, data_checked, data_checked_at, updated_at
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
  correction?: TournamentReviewCorrection,
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
    const previousHead = await tx<
      Array<{
        event_name: string | null;
        tournament_payload: JsonRecord | null;
        payload: JsonRecord | null;
        revision: number | string;
        content_sha256: string;
        publication_content_sha256: string;
        published_at: Date | string;
        obligation_state: TournamentReviewObligationState | null;
        correction_reason: string | null;
        correction_change_id: string | null;
        row_count: number;
        expected_subject_count: number;
        ready_subject_count: number;
        not_applicable_subject_count: number;
      }>
    >`
      SELECT publication.payload #>> '{event,name}' AS event_name,
             publication.payload #> '{tournament}' AS tournament_payload,
             publication.payload,
             head.revision,
             head.content_sha256,
             publication.content_sha256 AS publication_content_sha256,
             head.published_at,
             obligation.state AS obligation_state,
             publication.correction_reason,
             publication.correction_change_id,
             publication.row_count,
             publication.expected_subject_count,
             publication.ready_subject_count,
             publication.not_applicable_subject_count
      FROM competition.tournament_review_heads head
      JOIN competition.tournament_review_publications publication
        ON publication.season_id = head.season_id
       AND publication.tournament_id = head.tournament_id
       AND publication.event_id = head.event_id
       AND publication.revision = head.revision
      LEFT JOIN competition.tournament_review_obligations obligation
        ON obligation.season_id = head.season_id
       AND obligation.tournament_id = head.tournament_id
       AND obligation.event_id = head.event_id
      WHERE head.season_id = ${season.seasonId}
        AND head.tournament_id = ${tournamentId}
        AND head.event_id = ${eventId}
      LIMIT 1
    `;
    const previousChunks = previousHead[0]
      ? await tx<
          Array<{
            section_key: string;
            chunk_index: number | string;
            item_count: number | string;
            chunk_sha256: string;
            items: unknown;
          }>
        >`
          SELECT section_key, chunk_index, item_count, chunk_sha256, items
          FROM competition.tournament_review_publication_chunks
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
            AND event_id = ${eventId}
            AND revision = ${previousHead[0].revision}
        `
      : [];
    // A finalized scope is an immutable business snapshot.  Routine source
    // refreshes (or a duplicate scheduler delivery) must not move its head;
    // only the service-only correction entry point below may create revision 2+.
    const previousPublicationIsCoherent =
      previousHead[0] !== undefined &&
      previousHead[0].publication_content_sha256 === previousHead[0].content_sha256 &&
      reviewChunksMatchPayload(previousHead[0].payload, previousChunks) &&
      tournamentReviewSemanticSha256(
        previousHead[0].payload,
        orderedReviewChunkHashes(previousChunks),
      ) === previousHead[0].content_sha256;
    const routineReuse = !correction && previousHead[0]?.obligation_state === 'READY';
    // A correction command is idempotent by Change ID.  If the transaction
    // committed the new publication but the worker lost its lease before
    // marking the obligation READY, a retry must reuse that exact revision
    // instead of minting another correction revision.
    const correctionReuse =
      correction !== undefined &&
      previousHead[0]?.correction_change_id === correction.changeId &&
      previousHead[0]?.correction_reason === correction.reason &&
      (previousHead[0]?.obligation_state === 'PROCESSING' ||
        previousHead[0]?.obligation_state === 'READY' ||
        previousHead[0]?.obligation_state === 'PENDING');
    if (previousPublicationIsCoherent && (routineReuse || correctionReuse)) {
      const publishedAt = asDate(previousHead[0].published_at) ?? new Date();
      await tx`
        UPDATE competition.tournament_review_obligations
        SET last_observed_at = clock_timestamp(),
            last_noop_at = clock_timestamp()
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
          AND event_id = ${eventId}
      `;
      return {
        seasonId: season.seasonId,
        tournamentId,
        eventId,
        revision: Number(previousHead[0].revision),
        format,
        contentSha256: previousHead[0].content_sha256,
        rowCount: previousHead[0].row_count,
        expectedSubjectCount: previousHead[0].expected_subject_count,
        readySubjectCount: previousHead[0].ready_subject_count,
        notApplicableSubjectCount: previousHead[0].not_applicable_subject_count,
        publishedAt,
        state: 'REUSED',
      };
    }
    // events.upsertBatch refreshes updated_at on every core sync. Include the
    // event row timestamp only for a new head or a payload-relevant name
    // correction, otherwise routine event refreshes would mint revisions.
    const eventMetadataChanged =
      previousHead.length === 0 || previousHead[0].event_name !== event.event_name;
    const header = eventReviewPayload(tournament, event, format, {
      sourceMin: eventDataCheckedAt,
      sourceMax: eventDataCheckedAt,
    });
    const tournamentMetadataChanged =
      previousHead.length === 0 ||
      postgresJsonbCanonicalJson(previousHead[0].tournament_payload) !==
        postgresJsonbCanonicalJson(header.tournament);
    const built =
      format === 'POINTS'
        ? await buildPointsPayload(tx, season.seasonId, tournament, event, header)
        : format === 'H2H'
          ? await buildH2HPayload(tx, season.seasonId, tournament, event, header)
          : await buildKnockoutPayload(tx, season.seasonId, tournament, event, header);
    const freshness = tournamentReviewSourceSpan(eventDataCheckedAt, [
      eventDataCheckedAt,
      ...(eventMetadataChanged ? [event.updated_at] : []),
      ...(tournamentMetadataChanged ? [tournament.tournament_updated_at] : []),
      ...built.sourceTimes,
    ]);
    const payload = {
      ...built.payload,
      // Readiness metadata is part of the immutable payload identity.  In a
      // knockout round an eliminated roster entry can change applicability
      // without appearing in `knockout.matches`; keeping these counts in the
      // hashed payload prevents a stale publication from being reused with
      // old readiness columns.
      readiness: {
        expectedSubjectCount: built.expectedSubjectCount,
        readySubjectCount: built.readySubjectCount,
        notApplicableSubjectCount: built.notApplicableSubjectCount,
        rowCount: built.rowCount,
      },
      freshness: {
        sourceMinCheckedAt: freshness.sourceMin.toISOString(),
        sourceMaxCheckedAt: freshness.sourceMax.toISOString(),
      },
    };
    const chunks = splitTournamentReviewChunks(payload);
    // Keep the durable publication row small enough for metadata reads while
    // retaining the producer's full payload during the transition.  The
    // section manifest is the exact contract used to prove chunk cardinality
    // and ordered hashes at the reader and Ops boundaries.
    const payloadWithManifest = {
      ...payload,
      manifest: reviewPublicationManifest(chunks),
    };
    const manifestPayload = reviewPublicationManifestPayload(
      payloadWithManifest,
      payloadWithManifest.manifest,
    );
    const contentSha256 = tournamentReviewSemanticSha256(
      manifestPayload,
      chunks.map((chunk) => chunk.chunkSha256),
    );
    const existing = await tx<
      Array<{
        revision: number | string;
        published_at: Date | string;
        content_sha256: string;
        payload: JsonRecord | null;
      }>
    >`
      SELECT revision, published_at, content_sha256, payload
      FROM competition.tournament_review_publications
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND event_id = ${eventId}
        AND content_sha256 = ${contentSha256}
      ORDER BY revision DESC
      LIMIT 1
    `;
    const existingChunks = existing[0]
      ? await tx<
          Array<{
            section_key: string;
            chunk_index: number | string;
            item_count: number | string;
            chunk_sha256: string;
            items: unknown;
          }>
        >`
          SELECT section_key, chunk_index, item_count, chunk_sha256, items
          FROM competition.tournament_review_publication_chunks
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
            AND event_id = ${eventId}
            AND revision = ${existing[0].revision}
        `
      : [];
    const existingPublicationIsCoherent =
      existing[0] !== undefined &&
      existing[0].content_sha256 === contentSha256 &&
      reviewChunksMatchPayload(existing[0].payload, existingChunks) &&
      tournamentReviewSemanticSha256(
        existing[0].payload,
        orderedReviewChunkHashes(existingChunks),
      ) === existing[0].content_sha256;
    if (existing[0] && !correction && !existingPublicationIsCoherent) {
      // A stored row with a matching hash is not enough to prove integrity:
      // payload or chunk JSON may have been damaged while the hash columns
      // remained unchanged.  Do not reuse or mutate that immutable revision;
      // require an explicit, audited correction to replace it.
      throw new TournamentReviewPublicationError(
        'stored review publication is incoherent; explicit correction required',
      );
    }
    let revision: number;
    let publishedAt: Date;
    let state: 'PUBLISHED' | 'REUSED';
    // A correction is an audited event even when the rebuilt business content
    // returns to an earlier semantic hash (A -> B -> A).  Do not reuse the
    // earlier revision: allocate a new monotonically increasing revision so
    // the reason/Change ID remains attached to a durable publication row.
    if (existing[0] && !correction && existingPublicationIsCoherent) {
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
      if (revision === 1 && correction) {
        throw new TournamentReviewPublicationError(
          'initial review publication cannot be a correction',
        );
      }
      if (revision > 1 && !correction) {
        throw new TournamentReviewPublicationError(
          'a READY review can advance only through an explicit correction',
        );
      }
      const inserted = await tx<Array<{ published_at: Date | string }>>`
        INSERT INTO competition.tournament_review_publications (
          season_id, tournament_id, event_id, revision, format,
          schema_version, metric_version, event_data_checked_at,
          source_min_checked_at, source_max_checked_at,
          expected_subject_count, ready_subject_count, not_applicable_subject_count,
          row_count, content_sha256, payload, correction_reason, correction_change_id
        ) VALUES (
          ${season.seasonId}, ${tournamentId}, ${eventId}, ${revision}, ${format},
          ${TOURNAMENT_REVIEW_SCHEMA_VERSION}, ${TOURNAMENT_REVIEW_METRIC_VERSION},
          ${eventDataCheckedAt.toISOString()}::timestamptz,
          ${freshness.sourceMin.toISOString()}::timestamptz,
          ${freshness.sourceMax.toISOString()}::timestamptz,
          ${built.expectedSubjectCount}, ${built.readySubjectCount},
          ${built.notApplicableSubjectCount}, ${built.rowCount}, ${contentSha256},
          ${JSON.stringify(manifestPayload)}::jsonb,
          ${correction?.reason ?? null}, ${correction?.changeId ?? null}
        ) RETURNING published_at
      `;
      publishedAt = asDate(inserted[0]?.published_at) ?? new Date();
      state = 'PUBLISHED';
    }
    // Chunks and publication/head are written under the same transaction and
    // advisory lock.  A crash before commit leaves no visible sibling set;
    // a repeated job safely recreates missing chunks for an existing revision.
    for (const chunk of chunks) {
      await tx`
        INSERT INTO competition.tournament_review_publication_chunks (
          season_id, tournament_id, event_id, revision, section_key, chunk_index,
          item_count, chunk_sha256, items
        ) VALUES (
          ${season.seasonId}, ${tournamentId}, ${eventId}, ${revision},
          ${chunk.sectionKey}, ${chunk.chunkIndex}, ${chunk.itemCount},
          ${chunk.chunkSha256}, ${JSON.stringify(chunk.items)}::jsonb
        )
        ON CONFLICT (season_id, tournament_id, event_id, revision, section_key, chunk_index)
        DO UPDATE SET item_count = EXCLUDED.item_count,
                      chunk_sha256 = EXCLUDED.chunk_sha256,
                      items = EXCLUDED.items
      `;
    }
    // A retried repair may encounter an orphaned sibling left by an older
    // writer. Replace the revision's chunk set exactly so a READY head cannot
    // remain permanently incoherent because of an unexpected extra row.
    const expectedChunkKeys = JSON.stringify(
      chunks.map((chunk) => ({ section_key: chunk.sectionKey, chunk_index: chunk.chunkIndex })),
    );
    await tx`
      DELETE FROM competition.tournament_review_publication_chunks chunk
      WHERE chunk.season_id = ${season.seasonId}
        AND chunk.tournament_id = ${tournamentId}
        AND chunk.event_id = ${eventId}
        AND chunk.revision = ${revision}
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(${expectedChunkKeys}::jsonb) AS expected(section_key text, chunk_index integer)
          WHERE expected.section_key = chunk.section_key
            AND expected.chunk_index = chunk.chunk_index
        )
    `;
    await tx`
      UPDATE competition.tournament_review_obligations
      SET last_observed_at = clock_timestamp(),
          last_noop_at = CASE WHEN ${state === 'REUSED'} THEN clock_timestamp() ELSE last_noop_at END,
          last_semantic_change_at = CASE
            WHEN ${state === 'PUBLISHED'} THEN clock_timestamp()
            ELSE last_semantic_change_at
          END
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND event_id = ${eventId}
    `;
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
  correction?: TournamentReviewCorrection,
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
      return await publishTournamentReviewScopeOnce(season, tournamentId, eventId, correction);
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

/** Explicit correction is the only path that can advance a READY scope. */
export async function publishTournamentReviewCorrection(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
  reason: string,
  changeId: string,
): Promise<TournamentReviewPublicationResult> {
  if (!reason.trim() || !changeId.trim()) {
    throw new Error('correction reason and changeId are required');
  }
  return publishTournamentReviewScope(season, tournamentId, eventId, {
    mode: 'CORRECTION',
    reason: reason.trim(),
    changeId: changeId.trim(),
  });
}

/** Reset a frozen scope and all later descendants for an explicit, audited
 * correction. A null target selects the earliest READY scope in a tournament
 * and is used by topology repair, which can invalidate every later phase. */
async function resetTournamentReviewScopesForCorrection(
  season: FplSeasonRef,
  tournamentId: number,
  targetEventId: number | null,
  reason: string,
  changeId: string,
  allowEmpty = false,
): Promise<number[]> {
  const db = await getDbClient();
  const rows: Array<{ event_id: number }> = await db.begin(
    async (tx): Promise<Array<{ event_id: number }>> => {
      const targetRows = await tx<Array<{ event_id: number }>>`
      SELECT candidate.event_id
      FROM (
        SELECT head.event_id
        FROM competition.tournament_review_heads head
        WHERE head.season_id = ${season.seasonId}
          AND head.tournament_id = ${tournamentId}
        UNION
        SELECT obligation.event_id
        FROM competition.tournament_review_obligations obligation
        WHERE obligation.season_id = ${season.seasonId}
          AND obligation.tournament_id = ${tournamentId}
      ) candidate
      WHERE (
        -- A service-requested correction names the repaired event, but that
        -- event may never have produced a head. In that case fence the first
        -- later frozen READY scope so every descendant is rebuilt from the
        -- repaired source facts. A topology repair has no event target and
        -- instead fences the earliest existing head or in-flight obligation.
        ${targetEventId}::integer IS NULL
        OR (
          candidate.event_id >= ${targetEventId}
          AND (
            EXISTS (
              SELECT 1
              FROM competition.tournament_review_heads head
              JOIN competition.tournament_review_obligations obligation
                ON obligation.season_id = head.season_id
               AND obligation.tournament_id = head.tournament_id
               AND obligation.event_id = head.event_id
              WHERE head.season_id = ${season.seasonId}
                AND head.tournament_id = ${tournamentId}
                AND head.event_id = candidate.event_id
                AND obligation.state = 'READY'
            )
            OR (
              candidate.event_id = ${targetEventId}
              AND EXISTS (
                SELECT 1
                FROM competition.tournament_review_obligations obligation
                WHERE obligation.season_id = ${season.seasonId}
                  AND obligation.tournament_id = ${tournamentId}
                  AND obligation.event_id = candidate.event_id
                  AND obligation.state = 'PROCESSING'
              )
            )
          )
        )
      )
      ORDER BY candidate.event_id
      LIMIT 1
    `;
      if (targetRows.length === 0) {
        if (allowEmpty) return [];
        throw new Error('only an existing READY review scope can be corrected');
      }
      const correctionTargetEventId = targetRows[0].event_id;
      // Publishers take the same scope advisory lock before reading or writing
      // a head. Lock every descendant before clearing a PROCESSING lease so an
      // in-flight worker cannot publish the superseded snapshot after this
      // correction request commits.
      const descendantRows = await tx<Array<{ event_id: number }>>`
      SELECT candidate.event_id
      FROM (
        SELECT head.event_id
        FROM competition.tournament_review_heads head
        WHERE head.season_id = ${season.seasonId}
          AND head.tournament_id = ${tournamentId}
        UNION
        SELECT obligation.event_id
        FROM competition.tournament_review_obligations obligation
        WHERE obligation.season_id = ${season.seasonId}
          AND obligation.tournament_id = ${tournamentId}
      ) candidate
      WHERE candidate.event_id >= ${correctionTargetEventId}
      ORDER BY candidate.event_id
    `;
      for (const descendant of descendantRows) {
        await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'review:' || ${season.seasonId}::text || ':' || ${tournamentId}::text || ':' || ${descendant.event_id}::text,
            0
          )
        )
      `;
      }
      const rowsAfterLocks = await tx<Array<{ event_id: number }>>`
      UPDATE competition.tournament_review_obligations obligation
      SET state = 'PENDING',
          next_attempt_at = clock_timestamp(),
          execution_attempts = 0,
          source_rechecks = 0,
          lease_owner = NULL,
          lease_expires_at = NULL,
          first_attempt_at = NULL,
          last_attempt_at = NULL,
          ready_at = NULL,
          degraded_at = NULL,
          ready_revision = NULL,
          last_error_code = NULL,
          last_failure_fingerprint = NULL,
          -- Keep any attached repair issue on the descendant. The claimed
          -- obligation carries this id into finishReviewObligation, which
          -- resolves it in the same transaction as READY. Clearing it here
          -- would leave an unresolved setup issue after a successful
          -- correction.
          -- Only scopes with an existing immutable head are correction
          -- publications. Headless descendants remain initial publications.
          correction_reason = CASE WHEN EXISTS (
            SELECT 1
            FROM competition.tournament_review_heads head
            WHERE head.season_id = obligation.season_id
              AND head.tournament_id = obligation.tournament_id
              AND head.event_id = obligation.event_id
          ) THEN ${reason} ELSE NULL END,
          correction_change_id = CASE WHEN EXISTS (
            SELECT 1
            FROM competition.tournament_review_heads head
            WHERE head.season_id = obligation.season_id
              AND head.tournament_id = obligation.tournament_id
              AND head.event_id = obligation.event_id
          ) THEN ${changeId} ELSE NULL END,
          updated_at = clock_timestamp()
      WHERE obligation.season_id = ${season.seasonId}
        AND obligation.tournament_id = ${tournamentId}
        AND obligation.event_id >= ${correctionTargetEventId}
        AND obligation.state IN ('READY', 'PROCESSING', 'PENDING', 'WAITING_SOURCE', 'DEGRADED')
      RETURNING obligation.event_id
    `;
      if (rowsAfterLocks.length === 0) {
        if (allowEmpty) return [];
        throw new Error('only an existing READY review scope can be corrected');
      }
      return rowsAfterLocks;
    },
  );
  if (rows.length === 0 && !allowEmpty) {
    throw new Error('only an existing READY review scope can be corrected');
  }
  return rows.map((row) => row.event_id);
}

/** Mark one frozen scope for an explicit, audited correction. Routine source
 * reconciliation never performs this transition; callers must provide both
 * a human-readable reason and an external Change ID before a revision >1 can
 * be published. */
export async function requestTournamentReviewCorrection(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
  reason: string,
  changeId: string,
  allowEmpty = false,
): Promise<number[]> {
  if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) {
    throw new Error('tournamentId must be a positive integer');
  }
  if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 38) {
    throw new Error('eventId must be between 1 and 38');
  }
  if (!reason.trim() || !changeId.trim()) {
    throw new Error('correction reason and changeId are required');
  }
  return resetTournamentReviewScopesForCorrection(
    season,
    tournamentId,
    eventId,
    reason.trim(),
    changeId.trim(),
    allowEmpty,
  );
}

/** Reset all settled review scopes affected by a tournament-wide topology
 * repair. Returning an empty list is valid when the tournament has not
 * published a review head yet. */
export async function requestTournamentReviewTournamentCorrection(
  season: FplSeasonRef,
  tournamentId: number,
  reason: string,
  changeId: string,
): Promise<number[]> {
  if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) {
    throw new Error('tournamentId must be a positive integer');
  }
  if (!reason.trim() || !changeId.trim()) {
    throw new Error('correction reason and changeId are required');
  }
  return resetTournamentReviewScopesForCorrection(
    season,
    tournamentId,
    null,
    reason.trim(),
    changeId.trim(),
    true,
  );
}

export async function reconcileTournamentReviewObligations(
  season: FplSeasonRef,
  now = new Date(),
  target: { tournamentId?: number; eventId?: number } = {},
): Promise<number> {
  const targetTournamentId = target.tournamentId ?? null;
  const targetEventId = target.eventId ?? null;
  const rows = await withDatabaseTransaction(async (tx) => {
    // First identify only scopes that could be retired. The lock set is
    // intentionally a bounded candidate set rather than the full review
    // history, so reconciliation does not block publishers for every past
    // gameweek. The later candidate statement revalidates this set after the
    // locks are held using a fresh READ COMMITTED snapshot.
    const potentialStaleScopes = await tx<Array<{ tournament_id: number; event_id: number }>>`
      WITH stored_scopes AS (
        SELECT tournament_id, event_id
        FROM competition.tournament_review_heads
        WHERE season_id = ${season.seasonId}
        UNION
        SELECT tournament_id, event_id
        FROM competition.tournament_review_obligations
        WHERE season_id = ${season.seasonId}
      )
      SELECT stored.tournament_id, stored.event_id
      FROM stored_scopes stored
      WHERE NOT EXISTS (
        SELECT 1
        FROM competition.tournaments tournament
        JOIN fpl.events event
          ON event.season_id = tournament.season_id
         AND event.event_id = stored.event_id
        WHERE tournament.season_id = ${season.seasonId}
          AND tournament.tournament_id = stored.tournament_id
          AND tournament.setup_status = 'ready'
          AND (
            (
              tournament.knockout_mode <> 'no_knockout'
              AND tournament.knockout_started_event_id IS NOT NULL
              AND event.event_id >= tournament.knockout_started_event_id
              AND (
                tournament.knockout_ended_event_id IS NULL
                OR event.event_id <= tournament.knockout_ended_event_id
              )
            )
            OR (
              tournament.group_mode IN ('points_races', 'battle_races')
              AND tournament.group_started_event_id IS NOT NULL
              AND event.event_id >= tournament.group_started_event_id
              AND (
                tournament.group_ended_event_id IS NULL
                OR event.event_id <= tournament.group_ended_event_id
              )
            )
          )
      )
        AND (${targetTournamentId}::integer IS NULL OR stored.tournament_id = ${targetTournamentId})
        AND (${targetEventId}::integer IS NULL OR stored.event_id = ${targetEventId})
      ORDER BY stored.tournament_id, stored.event_id
    `;
    for (const scope of potentialStaleScopes) {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            'review:' || ${season.seasonId}::text || ':' || ${scope.tournament_id}::text || ':' || ${scope.event_id}::text,
            0
          )
        )
      `;
    }
    const lockedStaleScopesJson = JSON.stringify(potentialStaleScopes);
    return tx<
      Array<{
        upserted_count: number | string;
        retired_head_count: number | string;
        retired_obligation_count: number | string;
      }>
    >`
    WITH entry_metadata AS MATERIALIZED (
      SELECT tournament.season_id,
             tournament.tournament_id,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'entryId', entry.entry_id,
                   'entryName', entry.entry_name,
                   'playerName', entry.player_name,
                   'startedEvent', entry.started_event
                 )
                 ORDER BY entry.entry_id
               ) FILTER (WHERE entry.entry_id IS NOT NULL),
               '[]'::jsonb
             ) AS entry_metadata_payload,
             max(GREATEST(entry.updated_at, tournament_entry.created_at))
               FILTER (WHERE entry.entry_id IS NOT NULL) AS entry_metadata_updated_at
      FROM competition.tournaments tournament
      LEFT JOIN competition.tournament_entries tournament_entry
        ON tournament_entry.season_id = tournament.season_id
       AND tournament_entry.tournament_id = tournament.tournament_id
      LEFT JOIN competition.entries entry
        ON entry.season_id = tournament_entry.season_id
       AND entry.entry_id = tournament_entry.entry_id
      WHERE tournament.season_id = ${season.seasonId}
        AND tournament.setup_status = 'ready'
      GROUP BY tournament.season_id, tournament.tournament_id
    ), canonical_group_assignments AS MATERIALIZED (
      SELECT tournament.season_id,
             tournament.tournament_id,
             jsonb_build_object(
               'count', count(group_row.entry_id)::integer,
               'assignments', COALESCE(
                 jsonb_object_agg(
                   group_row.entry_id::text,
                   to_jsonb(group_row.group_id)
                   ORDER BY group_row.entry_id
                 ) FILTER (WHERE group_row.entry_id IS NOT NULL),
                 '{}'::jsonb
               )
             ) AS group_assignment_payload
      FROM competition.tournaments tournament
      LEFT JOIN competition.tournament_groups group_row
        ON group_row.season_id = tournament.season_id
       AND group_row.tournament_id = tournament.tournament_id
      WHERE tournament.season_id = ${season.seasonId}
        AND tournament.setup_status = 'ready'
      GROUP BY tournament.season_id, tournament.tournament_id
    ), candidate_formats AS (
      SELECT tournament.tournament_id,
             event.event_id,
             event.name AS event_name,
             event.updated_at AS event_updated_at,
             event.data_checked_at AS event_data_checked_at,
             tournament.setup_finished_at,
             tournament.standings_ready_at,
             tournament.updated_at AS tournament_updated_at,
             tournament.group_started_event_id,
             entry_metadata.entry_metadata_payload,
             entry_metadata.entry_metadata_updated_at,
             canonical_group_assignments.group_assignment_payload,
             jsonb_build_object(
               'id', tournament.tournament_id,
               'name', tournament.name,
               'creator', tournament.creator,
               'adminEntryId', tournament.admin_entry_id,
               'leagueId', tournament.league_id,
               'leagueType', tournament.league_type,
               'totalTeamNum', tournament.total_team_num,
               'groupMode', tournament.group_mode,
               'groupStartedEventId', tournament.group_started_event_id,
               'groupEndedEventId', tournament.group_ended_event_id,
               'knockoutMode', tournament.knockout_mode,
               'knockoutStartedEventId', tournament.knockout_started_event_id,
               'knockoutEndedEventId', tournament.knockout_ended_event_id
             ) AS tournament_payload,
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
             END AS format
      FROM competition.tournaments tournament
      JOIN fpl.events event ON event.season_id = tournament.season_id
      LEFT JOIN entry_metadata
        ON entry_metadata.season_id = tournament.season_id
       AND entry_metadata.tournament_id = tournament.tournament_id
      LEFT JOIN canonical_group_assignments
        ON canonical_group_assignments.season_id = tournament.season_id
       AND canonical_group_assignments.tournament_id = tournament.tournament_id
      WHERE tournament.season_id = ${season.seasonId}
        AND tournament.setup_status = 'ready'
        AND event.finished = true
        AND event.data_checked = true
        AND event.data_checked_at IS NOT NULL
        AND (${targetTournamentId}::integer IS NULL OR tournament.tournament_id = ${targetTournamentId})
        AND (${targetEventId}::integer IS NULL OR event.event_id = ${targetEventId})
    ), candidate_states AS (
      SELECT candidate.tournament_id,
             candidate.event_id,
             candidate.event_name,
             candidate.event_updated_at,
             candidate.event_data_checked_at,
             candidate.setup_finished_at,
             candidate.standings_ready_at,
             candidate.tournament_updated_at,
             candidate.group_started_event_id,
             candidate.entry_metadata_payload,
             candidate.entry_metadata_updated_at,
             candidate.group_assignment_payload,
             candidate.tournament_payload,
             candidate.format,
             existing.eligible_at AS existing_eligible_at,
             history.historical_revision,
             existing.metadata_payload AS existing_metadata_payload,
             existing.group_assignment_payload AS existing_group_assignment_payload,
             previous.payload AS existing_payload,
             CASE
             WHEN existing.metadata_payload IS NOT NULL
                AND existing.metadata_payload IS DISTINCT FROM candidate.tournament_payload
                 THEN GREATEST(
                   candidate.tournament_updated_at,
                   COALESCE(existing.eligible_at, '-infinity'::timestamptz) + interval '1 microsecond'
                 )
               ELSE '-infinity'::timestamptz
             END AS tournament_metadata_eligible_at,
             CASE
               WHEN existing.entry_metadata_payload IS NOT NULL
                AND existing.entry_metadata_payload IS DISTINCT FROM candidate.entry_metadata_payload
                 THEN GREATEST(
                   COALESCE(candidate.entry_metadata_updated_at, clock_timestamp()),
                   COALESCE(existing.eligible_at, '-infinity'::timestamptz) + interval '1 microsecond'
                 )
               ELSE '-infinity'::timestamptz
             END AS entry_metadata_eligible_at,
             CASE
              WHEN (existing.group_assignment_payload IS NOT NULL OR previous.payload IS NOT NULL)
               AND (
                 existing.state = 'READY'
                 OR (existing.state = 'DEGRADED' AND existing.next_attempt_at IS NULL)
               )
               AND candidate.format IN ('POINTS', 'H2H')
                AND COALESCE(
                  existing.group_assignment_payload,
                  (
                    SELECT jsonb_build_object(
                      'count', count(*)::integer,
                      'assignments', COALESCE(
                        jsonb_object_agg(
                          payload_row->>'entryId',
                          payload_row->'groupId'
                        ) FILTER (WHERE payload_row->>'entryId' IS NOT NULL),
                        '{}'::jsonb
                      )
                    )
                    FROM jsonb_array_elements(
                      CASE candidate.format
                        WHEN 'POINTS' THEN
                          CASE
                            WHEN jsonb_typeof(previous.payload #> '{points,rows}') = 'array'
                              THEN previous.payload #> '{points,rows}'
                            ELSE '[]'::jsonb
                          END
                        WHEN 'H2H' THEN
                          CASE
                            WHEN jsonb_typeof(previous.payload #> '{h2h,standings}') = 'array'
                              THEN previous.payload #> '{h2h,standings}'
                            ELSE '[]'::jsonb
                          END
                        ELSE '[]'::jsonb
                      END
                    ) payload_row
                  )
                ) IS DISTINCT FROM candidate.group_assignment_payload
                 THEN GREATEST(
                   COALESCE(candidate.tournament_updated_at, clock_timestamp()),
                   COALESCE(existing.eligible_at, '-infinity'::timestamptz) + interval '1 microsecond'
                 )
               ELSE '-infinity'::timestamptz
             END AS group_assignment_eligible_at
      FROM candidate_formats candidate
      LEFT JOIN competition.tournament_review_obligations existing
        ON existing.season_id = ${season.seasonId}
       AND existing.tournament_id = candidate.tournament_id
       AND existing.event_id = candidate.event_id
      LEFT JOIN LATERAL (
        SELECT max(publication.revision) AS historical_revision
        FROM competition.tournament_review_publications publication
        WHERE publication.season_id = ${season.seasonId}
          AND publication.tournament_id = candidate.tournament_id
          AND publication.event_id = candidate.event_id
      ) history ON true
      LEFT JOIN LATERAL (
        SELECT CASE publication.format
                 WHEN 'POINTS' THEN jsonb_set(
                   publication.payload,
                   '{points,rows}',
                   COALESCE(
                     (
                       SELECT jsonb_agg(item.value ORDER BY chunk.chunk_index, item.ordinality)
                       FROM competition.tournament_review_publication_chunks chunk
                       CROSS JOIN LATERAL jsonb_array_elements(chunk.items) WITH ORDINALITY AS item(value, ordinality)
                       WHERE chunk.season_id = publication.season_id
                         AND chunk.tournament_id = publication.tournament_id
                         AND chunk.event_id = publication.event_id
                         AND chunk.revision = publication.revision
                         AND chunk.section_key = 'POINTS_STANDINGS'
                     ),
                     '[]'::jsonb
                   )
                 )
                 WHEN 'H2H' THEN jsonb_set(
                   jsonb_set(
                     publication.payload,
                     '{h2h,matches}',
                     COALESCE(
                       (
                         SELECT jsonb_agg(item.value ORDER BY chunk.chunk_index, item.ordinality)
                         FROM competition.tournament_review_publication_chunks chunk
                         CROSS JOIN LATERAL jsonb_array_elements(chunk.items) WITH ORDINALITY AS item(value, ordinality)
                         WHERE chunk.season_id = publication.season_id
                           AND chunk.tournament_id = publication.tournament_id
                           AND chunk.event_id = publication.event_id
                           AND chunk.revision = publication.revision
                           AND chunk.section_key = 'H2H_FIXTURES'
                       ),
                       '[]'::jsonb
                     )
                   ),
                   '{h2h,standings}',
                   COALESCE(
                     (
                       SELECT jsonb_agg(item.value ORDER BY chunk.chunk_index, item.ordinality)
                       FROM competition.tournament_review_publication_chunks chunk
                       CROSS JOIN LATERAL jsonb_array_elements(chunk.items) WITH ORDINALITY AS item(value, ordinality)
                       WHERE chunk.season_id = publication.season_id
                         AND chunk.tournament_id = publication.tournament_id
                         AND chunk.event_id = publication.event_id
                         AND chunk.revision = publication.revision
                         AND chunk.section_key = 'H2H_STANDINGS'
                     ),
                     '[]'::jsonb
                   )
                 )
                 WHEN 'KNOCKOUT' THEN jsonb_set(
                   publication.payload,
                   '{knockout,matches}',
                   COALESCE(
                     (
                       SELECT jsonb_agg(item.value ORDER BY chunk.chunk_index, item.ordinality)
                       FROM competition.tournament_review_publication_chunks chunk
                       CROSS JOIN LATERAL jsonb_array_elements(chunk.items) WITH ORDINALITY AS item(value, ordinality)
                       WHERE chunk.season_id = publication.season_id
                         AND chunk.tournament_id = publication.tournament_id
                         AND chunk.event_id = publication.event_id
                         AND chunk.revision = publication.revision
                         AND chunk.section_key = 'KNOCKOUT_BRACKET'
                     ),
                     '[]'::jsonb
                   )
                 )
                 ELSE publication.payload
               END AS payload
        FROM competition.tournament_review_heads head
        JOIN competition.tournament_review_publications publication
          ON publication.season_id = head.season_id
         AND publication.tournament_id = head.tournament_id
         AND publication.event_id = head.event_id
         AND publication.revision = head.revision
        WHERE head.season_id = ${season.seasonId}
          AND head.tournament_id = candidate.tournament_id
          AND head.event_id = candidate.event_id
        LIMIT 1
      ) previous ON true
    ), candidates AS (
      SELECT state.tournament_id,
             state.event_id,
             state.format,
             state.historical_revision,
             state.tournament_payload,
             state.entry_metadata_payload,
             state.group_assignment_payload,
             GREATEST(
               state.event_data_checked_at,
               COALESCE(state.setup_finished_at, '-infinity'::timestamptz),
               COALESCE(state.standings_ready_at, '-infinity'::timestamptz),
               COALESCE(state.tournament_metadata_eligible_at, '-infinity'::timestamptz),
               COALESCE(state.entry_metadata_eligible_at, '-infinity'::timestamptz),
               COALESCE(state.group_assignment_eligible_at, '-infinity'::timestamptz),
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
            AND (
              state.format <> 'KNOCKOUT'
              OR EXISTS (
                SELECT 1
                FROM competition.tournament_knockouts active_bracket
                WHERE active_bracket.season_id = roster.season_id
                  AND active_bracket.tournament_id = state.tournament_id
                  AND active_bracket.started_event_id <= state.event_id
                  AND (
                    active_bracket.ended_event_id IS NULL
                    OR active_bracket.ended_event_id >= state.event_id
                  )
                  AND (
                    active_bracket.home_entry_id = entry.entry_id
                    OR active_bracket.away_entry_id = entry.entry_id
                  )
              )
            )
            AND (
              state.existing_eligible_at IS NULL
              OR (
                state.existing_payload IS NOT NULL
                AND state.format = 'POINTS'
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(state.existing_payload->'points'->'rows', '[]'::jsonb)
                  ) payload_row
                  WHERE (payload_row->>'entryId')::integer = entry.entry_id
                    AND payload_row->>'entryName' IS NOT DISTINCT FROM entry.entry_name
                    AND payload_row->>'playerName' IS NOT DISTINCT FROM entry.player_name
                    AND (payload_row->>'applicable')::boolean IS NOT DISTINCT FROM (
                      entry.started_event IS NULL OR entry.started_event <= state.event_id
                    )
                )
              )
              OR (
                state.existing_payload IS NOT NULL
                AND state.format = 'H2H'
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(state.existing_payload->'h2h'->'standings', '[]'::jsonb)
                  ) payload_row
                  WHERE (payload_row->>'entryId')::integer = entry.entry_id
                    AND payload_row->>'entryName' IS NOT DISTINCT FROM entry.entry_name
                    AND (payload_row->>'applicable')::boolean IS NOT DISTINCT FROM (
                      entry.started_event IS NULL OR entry.started_event <= state.event_id
                    )
                )
              )
              OR (
                state.existing_payload IS NOT NULL
                AND state.format = 'KNOCKOUT'
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                    COALESCE(state.existing_payload->'knockout'->'matches', '[]'::jsonb)
                  ) match_row
                  CROSS JOIN LATERAL jsonb_array_elements(
                    jsonb_build_array(match_row->'home', match_row->'away')
                  ) side
                  WHERE (side->>'entryId')::integer = entry.entry_id
                    AND side->>'entryName' IS NOT DISTINCT FROM entry.entry_name
                    AND (side->>'applicable')::boolean IS NOT DISTINCT FROM (
                      entry.started_event IS NULL OR entry.started_event <= state.event_id
                    )
                )
              )
            )
          UNION ALL
          SELECT state.event_updated_at AS source_updated_at
          WHERE state.event_updated_at > COALESCE(
              state.existing_eligible_at,
              '-infinity'::timestamptz
            )
            AND state.existing_payload IS NOT NULL
            AND state.existing_payload #>> '{event,name}' IS DISTINCT FROM state.event_name
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
          JOIN competition.entries entry
            ON entry.season_id = result.season_id
           AND entry.entry_id = result.entry_id
          JOIN fpl.events result_event
            ON result_event.season_id = result.season_id
           AND result_event.event_id = result.event_id
          WHERE state.format IN ('POINTS', 'H2H')
            AND result.season_id = ${season.seasonId}
            AND result.event_id <= state.event_id
            AND result.event_id >= GREATEST(
              COALESCE(state.group_started_event_id, 1),
              COALESCE(entry.started_event, 1)
            )
            AND result_event.finished = true
            AND result_event.data_checked = true
            AND result_event.data_checked_at IS NOT NULL
            AND GREATEST(
              result.updated_at,
              COALESCE(result.rich_synced_at, '-infinity'::timestamptz)
            ) > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT points.updated_at AS source_updated_at
          FROM competition.tournament_points_group_results points
          JOIN fpl.events points_event
            ON points_event.season_id = points.season_id
           AND points_event.event_id = points.event_id
          WHERE state.format = 'POINTS'
            AND points.season_id = ${season.seasonId}
            AND points.tournament_id = state.tournament_id
            AND points.event_id <= state.event_id
            AND points_event.finished = true
            AND points_event.data_checked = true
            AND points_event.data_checked_at IS NOT NULL
            AND points.updated_at > COALESCE(state.existing_eligible_at, '-infinity'::timestamptz)
          UNION ALL
          SELECT battle.updated_at AS source_updated_at
          FROM competition.tournament_battle_group_results battle
          JOIN fpl.events battle_event
            ON battle_event.season_id = battle.season_id
           AND battle_event.event_id = battle.event_id
          WHERE state.format = 'H2H'
            AND battle.season_id = ${season.seasonId}
            AND battle.tournament_id = state.tournament_id
            AND battle.event_id <= state.event_id
            AND battle_event.finished = true
            AND battle_event.data_checked = true
            AND battle_event.data_checked_at IS NOT NULL
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
            AND EXISTS (
              SELECT 1
              FROM competition.tournament_knockouts active_bracket
              WHERE active_bracket.season_id = result.season_id
                AND active_bracket.tournament_id = state.tournament_id
                AND active_bracket.started_event_id <= state.event_id
                AND (active_bracket.ended_event_id IS NULL OR active_bracket.ended_event_id >= state.event_id)
                AND (
                  active_bracket.home_entry_id = result.entry_id
                  OR active_bracket.away_entry_id = result.entry_id
                )
            )
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
      SELECT tournament_id, event_id, format, eligible_at, historical_revision, tournament_payload,
             entry_metadata_payload, group_assignment_payload
      FROM candidates
    ), stored_scopes AS (
      SELECT tournament_id, event_id
      FROM competition.tournament_review_heads
      WHERE season_id = ${season.seasonId}
        AND (${targetTournamentId}::integer IS NULL OR tournament_id = ${targetTournamentId})
        AND (${targetEventId}::integer IS NULL OR event_id = ${targetEventId})
      UNION
      SELECT tournament_id, event_id
      FROM competition.tournament_review_obligations
      WHERE season_id = ${season.seasonId}
        AND (${targetTournamentId}::integer IS NULL OR tournament_id = ${targetTournamentId})
        AND (${targetEventId}::integer IS NULL OR event_id = ${targetEventId})
    ), stale_scopes AS (
      SELECT stored.tournament_id, stored.event_id
      FROM stored_scopes stored
      LEFT JOIN valid_candidates candidate
        ON candidate.tournament_id = stored.tournament_id
       AND candidate.event_id = stored.event_id
      WHERE candidate.tournament_id IS NULL
    ), locked_stale_scopes AS MATERIALIZED (
      -- Restrict retirement to the scopes identified before locking. The
      -- stale_scopes join above is re-evaluated after those locks, so a scope
      -- repaired concurrently is retained and a newly stale scope waits for
      -- the next reconciliation pass instead of being deleted unlocked.
      SELECT stale.tournament_id, stale.event_id
      FROM stale_scopes stale
      JOIN jsonb_array_elements(${lockedStaleScopesJson}::jsonb) locked(value)
        ON (locked.value->>'tournament_id')::integer = stale.tournament_id
       AND (locked.value->>'event_id')::integer = stale.event_id
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
      (season_id, tournament_id, event_id, format, state, eligible_at, first_eligible_at, next_attempt_at,
       metadata_payload, entry_metadata_payload, group_assignment_payload,
       correction_reason, correction_change_id)
    SELECT ${season.seasonId}, tournament_id, event_id, format, 'PENDING', eligible_at, eligible_at,
           GREATEST(eligible_at, ${now.toISOString()}::timestamptz),
           tournament_payload, entry_metadata_payload, group_assignment_payload,
           CASE
             WHEN historical_revision IS NOT NULL THEN ${TOURNAMENT_REVIEW_REACTIVATION_REASON}
             ELSE NULL
           END,
           CASE
             WHEN historical_revision IS NOT NULL THEN
               concat('SYSTEM-REACTIVATION:', ${season.seasonId}::text, ':', tournament_id::text, ':', event_id::text)
             ELSE NULL
           END
    FROM valid_candidates
    ON CONFLICT (season_id, tournament_id, event_id) DO UPDATE
    SET format = EXCLUDED.format,
        metadata_payload = EXCLUDED.metadata_payload,
        entry_metadata_payload = COALESCE(
          EXCLUDED.entry_metadata_payload,
          competition.tournament_review_obligations.entry_metadata_payload
        ),
        group_assignment_payload = COALESCE(
          EXCLUDED.group_assignment_payload,
          competition.tournament_review_obligations.group_assignment_payload
        ),
        state = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN 'PENDING'
          ELSE competition.tournament_review_obligations.state
        END,
        eligible_at = GREATEST(
          competition.tournament_review_obligations.eligible_at,
          EXCLUDED.eligible_at
        ),
        first_eligible_at = COALESCE(
          competition.tournament_review_obligations.first_eligible_at,
          competition.tournament_review_obligations.eligible_at,
          EXCLUDED.first_eligible_at
        ),
        next_attempt_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN GREATEST(EXCLUDED.eligible_at, ${now.toISOString()}::timestamptz)
          ELSE COALESCE(
            competition.tournament_review_obligations.next_attempt_at,
            EXCLUDED.next_attempt_at
          )
        END,
        execution_attempts = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN 0
          ELSE competition.tournament_review_obligations.execution_attempts
        END,
        source_rechecks = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN 0
          ELSE competition.tournament_review_obligations.source_rechecks
        END,
        lease_owner = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.lease_owner
        END,
        lease_expires_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.lease_expires_at
        END,
        first_attempt_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.first_attempt_at
        END,
        last_attempt_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.last_attempt_at
        END,
        ready_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.ready_at
        END,
        degraded_at = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.degraded_at
        END,
        ready_revision = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.ready_revision
        END,
        last_error_code = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.last_error_code
        END,
        last_failure_fingerprint = CASE
          WHEN competition.tournament_review_obligations.state <> 'READY'
            AND (
              competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
              OR competition.tournament_review_obligations.format IS DISTINCT FROM EXCLUDED.format
            )
            THEN NULL
          ELSE competition.tournament_review_obligations.last_failure_fingerprint
        END,
        updated_at = clock_timestamp()
      WHERE competition.tournament_review_obligations.state <> 'PROCESSING'
      AND competition.tournament_review_obligations.state <> 'READY'
      AND (
        competition.tournament_review_obligations.metadata_payload IS NULL
        OR competition.tournament_review_obligations.entry_metadata_payload IS NULL
        OR competition.tournament_review_obligations.group_assignment_payload IS NULL
        OR competition.tournament_review_obligations.eligible_at < EXCLUDED.eligible_at
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
  first_eligible_at: Date | string;
  execution_attempts: number;
  source_rechecks: number;
  repair_issue_id: number | null;
  correction_reason: string | null;
  correction_change_id: string | null;
};

async function claimTournamentReviewObligations(
  season: FplSeasonRef,
  limit: number,
  target: { tournamentId?: number; eventId?: number } = {},
): Promise<{ owner: string; rows: ClaimedReviewObligation[] }> {
  const owner = randomUUID();
  const targetTournamentId = target.tournamentId ?? null;
  const targetEventId = target.eventId ?? null;
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
              AND next_attempt_at IS NOT NULL AND next_attempt_at <= clock_timestamp())
            OR (state = 'PROCESSING' AND lease_expires_at < clock_timestamp())
          )
          AND (${targetTournamentId}::integer IS NULL OR tournament_id = ${targetTournamentId})
          AND (${targetEventId}::integer IS NULL OR event_id = ${targetEventId})
        ORDER BY next_attempt_at NULLS FIRST, event_id, tournament_id
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}
      )
      UPDATE competition.tournament_review_obligations obligation
      SET state = 'PROCESSING',
          lease_owner = ${owner},
          lease_expires_at = clock_timestamp() + interval '2 minutes',
          first_attempt_at = COALESCE(first_attempt_at, clock_timestamp()),
          last_attempt_at = clock_timestamp(),
          updated_at = clock_timestamp()
      FROM candidates
      WHERE obligation.season_id = candidates.season_id
        AND obligation.tournament_id = candidates.tournament_id
        AND obligation.event_id = candidates.event_id
      RETURNING obligation.season_id, obligation.tournament_id, obligation.event_id,
                obligation.format, obligation.eligible_at, obligation.first_eligible_at,
	                obligation.execution_attempts, obligation.source_rechecks,
	                obligation.repair_issue_id,
	                obligation.correction_reason, obligation.correction_change_id
    `,
  );
  return { owner, rows };
}

const TOURNAMENT_REVIEW_LEASE_RENEW_INTERVAL_MS = 45_000;
const TOURNAMENT_REVIEW_DEGRADED_RETRY_DELAY_MS = 60 * 60_000;

async function renewReviewObligationLease(
  owner: string,
  obligation: ClaimedReviewObligation,
): Promise<boolean> {
  const db = await getDbClient();
  const rows = await db<Array<{ event_id: number }>>`
    UPDATE competition.tournament_review_obligations
    SET lease_expires_at = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    WHERE season_id = ${obligation.season_id}
      AND tournament_id = ${obligation.tournament_id}
      AND event_id = ${obligation.event_id}
      AND state = 'PROCESSING'
      AND lease_owner = ${owner}
    RETURNING event_id
  `;
  return rows.length === 1;
}

function reviewRepairIssue(
  obligation: ClaimedReviewObligation,
  error: TournamentReviewSourceNotReadyError,
  nextRepairAt: Date,
): TournamentSetupIssueInput {
  // Keep the persisted issue safe and stable. The source error text is useful
  // inside the Data process, but it may contain provider/table details and is
  // deliberately not copied into the repair queue or the public status API.
  // A missing/stale/mismatched match score is a results issue: the existing
  // repair worker must refresh the derived result rows before it can retry
  // publication.  Only roster/group/bracket topology failures use the
  // structure repair path; broad "match"/"winner" matching caused stale
  // source rows to be misrouted and deleted accepted result evidence.
  const structureFailure =
    /roster|group assignment|entry changed groups|bracket|participant.*(outside|coverage|invalid)|side contract|structure/i.test(
      error.message,
    );
  const code = structureFailure ? 'STRUCTURE_INTEGRITY_FAILED' : 'TOURNAMENT_RESULTS_INCOMPLETE';
  return {
    issueKey: setupIssueKey(code, obligation.event_id),
    code,
    category: 'results',
    severity: 'blocking',
    eventId: obligation.event_id,
    affectedEntryIds: [],
    diagnosticCode: structureFailure
      ? 'TOURNAMENT_REVIEW_STRUCTURE_INTEGRITY'
      : 'TOURNAMENT_REVIEW_RESULTS_INCOMPLETE',
    internalMessage: 'Settled tournament review source validation failed',
    nextRepairAt,
  };
}

/** Persist one deduplicated issue in the existing repair system and attach its
 * identity to the review obligation. A queue outage never hides the original
 * source failure; the issue remains durable for the watchdog to enqueue. */
async function enqueueTournamentReviewRepair(
  season: FplSeasonRef,
  obligation: ClaimedReviewObligation,
  error: TournamentReviewSourceNotReadyError,
  nextRepairAt: Date,
): Promise<number | null> {
  const db = await getDbClient();
  let affectedEntryIds: number[] = [];
  try {
    const rows = await db<Array<{ entry_id: number }>>`
      SELECT entry_id
      FROM competition.tournament_entries
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${obligation.tournament_id}
      ORDER BY entry_id
    `;
    affectedEntryIds = rows.map((row) => row.entry_id);
  } catch {
    // The issue is still actionable without an entry list: the existing
    // structure/results repair paths resolve the roster from the tournament.
  }
  const issue = {
    ...reviewRepairIssue(obligation, error, nextRepairAt),
    affectedEntryIds,
  } satisfies TournamentSetupIssueInput;
  try {
    const existing = await tournamentSetupIssueRepository.listUnresolved(
      season,
      obligation.tournament_id,
    );
    await tournamentSetupIssueRepository.sync(season, obligation.tournament_id, [issue], {
      preserveUnresolvedIssueKeys: existing.map((candidate) => candidate.issueKey),
    });
    const persisted = (
      await tournamentSetupIssueRepository.listUnresolved(season, obligation.tournament_id)
    ).find((candidate) => candidate.issueKey === issue.issueKey);
    if (!persisted) return null;
    try {
      // Load the queue adapter only on the failure path. Jobs/status and the
      // normal publication reader remain free of BullMQ connection setup.
      const { enqueueTournamentRepair } = await import('../jobs/tournament-repair.jobs');
      await enqueueTournamentRepair(season, persisted, 'reconciliation');
    } catch {
      // The persisted issue is the retry source of truth; the repair watchdog
      // will enqueue it when the queue is available again.
    }
    return persisted.issueId;
  } catch {
    return null;
  }
}

async function finishReviewObligation(
  owner: string,
  obligation: ClaimedReviewObligation,
  result: TournamentReviewPublicationResult,
): Promise<boolean> {
  const db = await getDbClient();
  return db.begin(async (tx) => {
    const rows = await tx<Array<{ event_id: number }>>`
      UPDATE competition.tournament_review_obligations
      SET state = 'READY', ready_revision = ${result.revision}, ready_at = clock_timestamp(),
          next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = NULL, last_failure_fingerprint = NULL, repair_issue_id = NULL,
          correction_reason = NULL, correction_change_id = NULL,
          updated_at = clock_timestamp()
      WHERE season_id = ${obligation.season_id}
        AND tournament_id = ${obligation.tournament_id}
        AND event_id = ${obligation.event_id}
        AND state = 'PROCESSING' AND lease_owner = ${owner}
      RETURNING event_id
    `;
    if (rows.length !== 1) return false;
    if (obligation.repair_issue_id !== null) {
      // Resolve only the issue attached to this obligation. A broad
      // tournament-level sync here could hide an unrelated open setup issue.
      // Keep this transition in the same transaction as READY so a transient
      // database failure cannot expose a completed review with a live blocker.
      await tx`
        UPDATE competition.tournament_setup_issues
        SET resolved_at = clock_timestamp(),
            next_repair_at = NULL,
            updated_at = clock_timestamp()
        WHERE season_id = ${obligation.season_id}
          AND tournament_id = ${obligation.tournament_id}
          AND issue_id = ${obligation.repair_issue_id}
          AND resolved_at IS NULL
      `;
      // `finishReviewObligation` resolves the attached issue directly so the
      // READY transition and repair evidence stay atomic. Recompute the
      // tournament readiness projection here as well; otherwise a successful
      // repair could leave `insights_ready_at` NULL until an unrelated setup
      // reconciliation happens.
      await tx`
        WITH issue_counts AS (
          SELECT
            count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'warning')::integer AS warning_count
          FROM competition.tournament_setup_issues
          WHERE season_id = ${obligation.season_id}
            AND tournament_id = ${obligation.tournament_id}
        )
        UPDATE competition.tournaments tournament
        SET setup_warning_count = issue_counts.warning_count,
            insights_ready_at = CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM competition.tournament_setup_issues issue
                WHERE issue.season_id = tournament.season_id
                  AND issue.tournament_id = tournament.tournament_id
                  AND issue.category IN ('insights', 'results')
                  AND issue.resolved_at IS NULL
              ) THEN COALESCE(tournament.insights_ready_at, clock_timestamp())
              ELSE NULL
            END,
            updated_at = clock_timestamp()
        FROM issue_counts
        WHERE tournament.season_id = ${obligation.season_id}
          AND tournament.tournament_id = ${obligation.tournament_id}
      `;
    }
    return true;
  });
}

async function failReviewObligation(
  season: FplSeasonRef,
  owner: string,
  obligation: ClaimedReviewObligation,
  error: unknown,
): Promise<boolean> {
  const sourceFailure = error instanceof TournamentReviewSourceNotReadyError;
  const failureNumber = sourceFailure
    ? obligation.source_rechecks + 1
    : obligation.execution_attempts + 1;
  const delay = tournamentReviewRetryDelayMs(sourceFailure ? 'source' : 'execution', failureNumber);
  const now = new Date();
  const eligibleAt = asDate(obligation.first_eligible_at) ?? asDate(obligation.eligible_at) ?? now;
  const horizon = new Date(eligibleAt.getTime() + 24 * 60 * 60_000);
  // The fast schedules end after three attempts, but that is not the
  // degradation threshold. Keep retrying every 15 minutes until the durable
  // 24-hour horizon; only then expose DEGRADED and move to the hourly cadence.
  const degraded = delay === null && now.getTime() >= horizon.getTime();
  const nextAt = degraded
    ? new Date(now.getTime() + TOURNAMENT_REVIEW_DEGRADED_RETRY_DELAY_MS)
    : delay === null
      ? new Date(Math.min(now.getTime() + 15 * 60_000, horizon.getTime()))
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
    `${obligation.tournament_id}:${obligation.event_id}:${sourceFailure ? 'source' : 'execution'}`,
  );
  const db = await getDbClient();
  const rows = await db<Array<{ event_id: number }>>`
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
    RETURNING event_id
  `;
  // Ownership is the admission boundary for the repair side effect.  A
  // reclaimed/stale worker must not create or enqueue a repair after another
  // worker has taken the lease.  Persist the failure transition first, then
  // attach the deduplicated issue to the still-current failure row.
  if (rows.length !== 1) return false;
  if (sourceFailure) {
    const repairIssueId = await enqueueTournamentReviewRepair(season, obligation, error, nextAt);
    if (repairIssueId !== null) {
      await db`
        UPDATE competition.tournament_review_obligations
        SET repair_issue_id = ${repairIssueId},
            updated_at = clock_timestamp()
        WHERE season_id = ${obligation.season_id}
          AND tournament_id = ${obligation.tournament_id}
          AND event_id = ${obligation.event_id}
          AND state = ${state}
          AND last_failure_fingerprint = ${fingerprint}
      `;
    }
  }
  logError('Tournament review obligation failed', error, {
    seasonId: obligation.season_id,
    tournamentId: obligation.tournament_id,
    eventId: obligation.event_id,
    code,
    state,
    nextAttemptAt: nextAt?.toISOString() ?? null,
  });
  return true;
}

export async function processTournamentReviewObligations(
  season: FplSeasonRef,
  options: {
    now?: Date;
    limit?: number;
    tournamentId?: number;
    eventId?: number;
    correction?: TournamentReviewCorrection;
  } = {},
): Promise<{ reconciled: number; claimed: number; published: number; failed: number }> {
  const now = options.now ?? new Date();
  const target = { tournamentId: options.tournamentId, eventId: options.eventId };
  const reconciled = await reconcileTournamentReviewObligations(season, now, target);
  const claimed = await claimTournamentReviewObligations(season, options.limit ?? 20, target);
  let published = 0;
  let failed = 0;
  const obligationKey = (obligation: ClaimedReviewObligation): string =>
    `${obligation.season_id}:${obligation.tournament_id}:${obligation.event_id}`;
  // The claim query returns a batch, but processing is deliberately
  // sequential. Keep one heartbeat over the complete outstanding claim set;
  // a timer scoped to the current loop item would let later claims expire
  // while an earlier publication is slow.
  const active = new Map(claimed.rows.map((obligation) => [obligationKey(obligation), obligation]));
  const leaseLost = new Set<string>();
  let renewalInFlight: Promise<void> | null = null;
  const renewAll = async (): Promise<void> => {
    if (!renewalInFlight) {
      renewalInFlight = Promise.all(
        [...active.entries()].map(async ([key, obligation]) => {
          try {
            if (!(await renewReviewObligationLease(claimed.owner, obligation))) {
              leaseLost.add(key);
            }
          } catch (error) {
            leaseLost.add(key);
            logError('Failed to renew tournament review obligation lease', error, {
              seasonId: obligation.season_id,
              tournamentId: obligation.tournament_id,
              eventId: obligation.event_id,
            });
          }
        }),
      )
        .then(() => undefined)
        .finally(() => {
          renewalInFlight = null;
        });
    }
    await renewalInFlight;
  };
  const leaseTimer = setInterval(() => {
    void renewAll().catch(() => undefined);
  }, TOURNAMENT_REVIEW_LEASE_RENEW_INTERVAL_MS);
  try {
    await renewAll();
    for (const obligation of claimed.rows) {
      const key = obligationKey(obligation);
      if (!active.has(key)) continue;
      // Ensure the row we are about to process is still owned after any
      // concurrent heartbeat pass. A lost claim is left for the next worker.
      await renewAll();
      if (leaseLost.has(key)) {
        active.delete(key);
        failed += 1;
        logInfo('Tournament review obligation lease was lost before publication', {
          seasonId: obligation.season_id,
          tournamentId: obligation.tournament_id,
          eventId: obligation.event_id,
        });
        continue;
      }
      try {
        const persistedCorrection =
          obligation.correction_reason && obligation.correction_change_id
            ? {
                mode: 'CORRECTION' as const,
                reason: obligation.correction_reason,
                changeId: obligation.correction_change_id,
              }
            : undefined;
        const queuedCorrection =
          options.correction &&
          options.tournamentId === obligation.tournament_id &&
          options.eventId === obligation.event_id
            ? options.correction
            : undefined;
        // The obligation row is the durable authorization for a correction.
        // Bull payloads are retry metadata and may be stale, duplicated, or
        // forged by an older producer; they must never create revision >1 on
        // their own. Headless descendants deliberately publish as initial
        // revisions even when the repair job carries the parent correction
        // payload. A mismatching queued value is therefore ignored rather
        // than allowed to override the persisted provenance.
        if (
          queuedCorrection &&
          (!persistedCorrection ||
            queuedCorrection.reason !== persistedCorrection.reason ||
            queuedCorrection.changeId !== persistedCorrection.changeId)
        ) {
          logInfo('Ignoring non-durable tournament review correction payload', {
            seasonId: obligation.season_id,
            tournamentId: obligation.tournament_id,
            eventId: obligation.event_id,
          });
        }
        const correction = persistedCorrection;
        const result = correction
          ? await publishTournamentReviewCorrection(
              season,
              obligation.tournament_id,
              obligation.event_id,
              correction.reason,
              correction.changeId,
            )
          : await publishTournamentReviewScope(
              season,
              obligation.tournament_id,
              obligation.event_id,
            );
        // A lost lease means another worker owns the obligation. The immutable
        // publication is idempotent, but this worker must not claim completion.
        if (!leaseLost.has(key)) {
          const finished = await finishReviewObligation(claimed.owner, obligation, result);
          if (finished) {
            published += 1;
          } else {
            failed += 1;
            logInfo('Tournament review obligation lease was lost before completion', {
              seasonId: obligation.season_id,
              tournamentId: obligation.tournament_id,
              eventId: obligation.event_id,
            });
          }
        } else {
          failed += 1;
          logInfo('Tournament review obligation lease was lost during publication', {
            seasonId: obligation.season_id,
            tournamentId: obligation.tournament_id,
            eventId: obligation.event_id,
          });
        }
      } catch (error) {
        failed += 1;
        const failedByOwner = await failReviewObligation(season, claimed.owner, obligation, error);
        if (!failedByOwner) {
          logInfo('Tournament review obligation lease was lost before failure recording', {
            seasonId: obligation.season_id,
            tournamentId: obligation.tournament_id,
            eventId: obligation.event_id,
          });
        }
      } finally {
        active.delete(key);
      }
    }
  } finally {
    clearInterval(leaseTimer);
    await Promise.resolve(renewalInFlight).catch(() => undefined);
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
    readyWithIncompleteChunks: number;
  }>;
  oldestActiveEligibleAt: string | null;
  oldestDegradedAt: string | null;
  latestUpdatedAt: string | null;
  watch: Readonly<{
    watchEntryId: number;
    tournaments: ReadonlyArray<{
      tournamentId: number;
      scopes: ReadonlyArray<
        Readonly<{
          eventId: number;
          format: TournamentReviewFormat;
          state: TournamentReviewObligationState;
          eligibleAt: string;
          nextAttemptAt: string | null;
          revision: number | null;
          readyRevision: number | null;
          publishedAt: string | null;
          eventDataCheckedAt: string | null;
          sourceMaxCheckedAt: string | null;
          updatedAt: string;
          lastErrorCode: string | null;
        }>
      >;
    }>;
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
  ready_chunk_complete_count: number | string;
  oldest_active_eligible_at: Date | string | null;
  oldest_degraded_at: Date | string | null;
  latest_updated_at: Date | string | null;
};

type TournamentReviewOperationalSemanticRow = {
  tournament_id: number;
  event_id: number;
  state: TournamentReviewObligationState;
  ready_revision: number | string | null;
  head_revision: number | string | null;
  head_content_sha256: string | null;
  publication_content_sha256: string | null;
  payload: JsonRecord | null;
  chunks: unknown;
};

type TournamentReviewOperationalWatchRow = {
  tournament_id: number;
  event_id: number;
  format: TournamentReviewFormat;
  state: TournamentReviewObligationState;
  first_eligible_at: Date | string;
  next_attempt_at: Date | string | null;
  ready_revision: number | string | null;
  active_revision: number | string | null;
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
  watchEntryId?: number,
  now = new Date(),
  options: { verifySemanticIntegrity?: boolean } = {},
): Promise<TournamentReviewV2OperationalStatus> {
  const db = await getDbClient();
  const aggregateRows = await db<TournamentReviewOperationalAggregateRow[]>`
      WITH joined AS (
        SELECT obligation.*,
               head.revision AS head_revision,
               head.content_sha256 AS head_content_sha256,
               publication.revision AS publication_revision,
               publication.content_sha256 AS publication_content_sha256,
               COALESCE(
                 CASE
                   -- Guard every JSON expansion and numeric conversion. A
                   -- corrupt manifest is evidence of an incoherent head, not
                   -- a reason for /jobs/status to fail with a 500.
                   WHEN jsonb_typeof(publication.payload) = 'object'
                    AND jsonb_typeof(publication.payload -> 'manifest') = 'object'
                    AND jsonb_typeof(publication.payload -> 'manifest' -> 'sections') = 'array'
                    AND (publication.payload -> 'manifest' ->> 'sectionCount') ~ '^[0-9]+$'
                    AND (publication.payload -> 'manifest' ->> 'chunkCount') ~ '^[0-9]+$'
                    AND jsonb_array_length(publication.payload -> 'manifest' -> 'sections') =
                      (publication.payload -> 'manifest' ->> 'sectionCount')::numeric
                    AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(publication.payload -> 'manifest' -> 'sections') section
                      WHERE jsonb_typeof(section) <> 'object'
                         OR jsonb_typeof(section -> 'sectionKey') <> 'string'
                         OR jsonb_typeof(section -> 'chunkHashes') <> 'array'
                         OR jsonb_typeof(section -> 'chunkItemCounts') <> 'array'
                         OR jsonb_array_length(section -> 'chunkHashes') IS DISTINCT FROM
                            jsonb_array_length(section -> 'chunkItemCounts')
                         OR EXISTS (
                           SELECT 1
                           FROM jsonb_array_elements_text(section -> 'chunkItemCounts') item_count
                           WHERE item_count.value !~ '^[0-9]+$'
                              OR CASE
                                   WHEN item_count.value ~ '^[0-9]+$'
                                   THEN item_count.value::numeric NOT BETWEEN 0 AND 100
                                   ELSE true
                                 END
                         )
                    )
                   THEN (
                     (
                       SELECT count(*)::numeric
                       FROM competition.tournament_review_publication_chunks chunk
                       WHERE chunk.season_id = obligation.season_id
                         AND chunk.tournament_id = obligation.tournament_id
                         AND chunk.event_id = obligation.event_id
                         AND chunk.revision = head.revision
                     ) = (publication.payload -> 'manifest' ->> 'chunkCount')::numeric
                     AND NOT EXISTS (
                       SELECT 1
                       FROM jsonb_array_elements(publication.payload -> 'manifest' -> 'sections') section
                       CROSS JOIN LATERAL jsonb_array_elements_text(
                         section -> 'chunkHashes'
                       ) WITH ORDINALITY expected(expected_hash, chunk_ordinal)
                       JOIN LATERAL jsonb_array_elements_text(
                         section -> 'chunkItemCounts'
                       ) WITH ORDINALITY expected_count(expected_item_count, count_ordinal)
                         ON expected_count.count_ordinal = expected.chunk_ordinal
                       WHERE NOT EXISTS (
                         SELECT 1
                         FROM competition.tournament_review_publication_chunks chunk
                         WHERE chunk.season_id = obligation.season_id
                           AND chunk.tournament_id = obligation.tournament_id
                           AND chunk.event_id = obligation.event_id
                           AND chunk.revision = head.revision
                           AND chunk.section_key = section ->> 'sectionKey'
                           AND chunk.chunk_index = expected.chunk_ordinal - 1
                           AND chunk.chunk_sha256 = expected.expected_hash
                           AND chunk.item_count::numeric = expected_count.expected_item_count::numeric
                       )
                     )
                   )
                   ELSE false
                 END,
                 false
               ) AS chunks_complete
        FROM competition.tournament_review_obligations obligation
        LEFT JOIN competition.tournament_review_heads head
          ON head.season_id = obligation.season_id
         AND head.tournament_id = obligation.tournament_id
         AND head.event_id = obligation.event_id
        LEFT JOIN competition.tournament_review_publications publication
          ON publication.season_id = obligation.season_id
         AND publication.tournament_id = obligation.tournament_id
         AND publication.event_id = obligation.event_id
         AND publication.revision = head.revision
        WHERE obligation.season_id = ${season.seasonId}
      )
      SELECT count(*)::integer AS eligible_count,
             count(*) FILTER (WHERE state = 'PENDING')::integer AS pending_count,
             count(*) FILTER (WHERE state = 'WAITING_SOURCE')::integer AS waiting_source_count,
             count(*) FILTER (WHERE state = 'PROCESSING')::integer AS processing_count,
             count(*) FILTER (WHERE state = 'READY')::integer AS ready_count,
             count(*) FILTER (WHERE state = 'DEGRADED')::integer AS degraded_count,
             count(*) FILTER (
               WHERE state = 'READY'
                 AND ready_revision IS NOT NULL
                 AND head_revision = ready_revision
                 AND head_content_sha256 = publication_content_sha256
                 AND chunks_complete
             )::integer AS ready_coherent_count,
             count(*) FILTER (
               WHERE state = 'READY'
                 AND NOT (
                   ready_revision IS NOT NULL
                   AND head_revision = ready_revision
                   AND head_content_sha256 = publication_content_sha256
                   AND chunks_complete
                 )
             )::integer AS ready_incoherent_count,
	             count(*) FILTER (
	               WHERE state = 'READY'
	                 AND chunks_complete
	             )::integer AS ready_chunk_complete_count,
             min(first_eligible_at) FILTER (WHERE state IN ('PENDING', 'WAITING_SOURCE', 'PROCESSING')) AS oldest_active_eligible_at,
             min(degraded_at) FILTER (WHERE state = 'DEGRADED') AS oldest_degraded_at,
             max(updated_at) AS latest_updated_at
      FROM joined
    `;
  const count = (value: number | string | null | undefined): number => {
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  };
  // The aggregate query above deliberately stays narrow for routine status
  // polling: it validates manifest/cardinality/hash-column parity without
  // transferring every chunk's JSON items into the Data process. The bounded
  // hard-cut gate opts into the full semantic digest below, which is the only
  // path that needs to materialize all sibling chunks to detect tampering that
  // left the stored hash columns untouched.
  let readyCoherentCount = count(aggregateRows[0]?.ready_coherent_count);
  let readyChunkCompleteCount = count(aggregateRows[0]?.ready_chunk_complete_count);
  const readyCount = count(aggregateRows[0]?.ready_count);
  if (options.verifySemanticIntegrity === true) {
    // Semantic verification is a bounded diagnostic/backfill path, never the
    // routine /jobs/status path. Keyset batches cap the number of publication
    // payloads/chunk arrays materialized in one database response while still
    // covering every READY scope when the explicit gate opts in.
    const semanticRows: TournamentReviewOperationalSemanticRow[] = [];
    let lastTournamentId = 0;
    let lastEventId = 0;
    for (;;) {
      const batch = await db<TournamentReviewOperationalSemanticRow[]>`
        SELECT obligation.tournament_id,
               obligation.event_id,
               obligation.state,
               obligation.ready_revision,
               head.revision AS head_revision,
               head.content_sha256 AS head_content_sha256,
               publication.content_sha256 AS publication_content_sha256,
               publication.payload,
               COALESCE(
                 (
                   SELECT jsonb_agg(
                     jsonb_build_object(
                       'section_key', chunk.section_key,
                       'chunk_index', chunk.chunk_index,
                       'item_count', chunk.item_count,
                       'chunk_sha256', chunk.chunk_sha256,
                       'items', chunk.items
                     )
                     ORDER BY chunk.section_key, chunk.chunk_index
                   )
                   FROM competition.tournament_review_publication_chunks chunk
                   WHERE chunk.season_id = obligation.season_id
                     AND chunk.tournament_id = obligation.tournament_id
                     AND chunk.event_id = obligation.event_id
                     AND chunk.revision = head.revision
                 ),
                 '[]'::jsonb
               ) AS chunks
        FROM competition.tournament_review_obligations obligation
        LEFT JOIN competition.tournament_review_heads head
          ON head.season_id = obligation.season_id
         AND head.tournament_id = obligation.tournament_id
         AND head.event_id = obligation.event_id
        LEFT JOIN competition.tournament_review_publications publication
          ON publication.season_id = head.season_id
         AND publication.tournament_id = head.tournament_id
         AND publication.event_id = head.event_id
         AND publication.revision = head.revision
        WHERE obligation.season_id = ${season.seasonId}
          AND obligation.state = 'READY'
          AND (obligation.tournament_id, obligation.event_id) > (${lastTournamentId}, ${lastEventId})
        ORDER BY obligation.tournament_id, obligation.event_id
        LIMIT ${TOURNAMENT_REVIEW_SEMANTIC_VERIFY_BATCH_SIZE}
      `;
      semanticRows.push(...batch);
      if (batch.length < TOURNAMENT_REVIEW_SEMANTIC_VERIFY_BATCH_SIZE) break;
      const last = batch[batch.length - 1];
      lastTournamentId = last.tournament_id;
      lastEventId = last.event_id;
    }
    const storedChunkRows = (
      value: unknown,
    ): Array<{
      section_key: string;
      chunk_index: number | string;
      item_count: number | string;
      chunk_sha256: string;
      items: unknown;
    }> => {
      if (!Array.isArray(value)) return [];
      return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.section_key !== 'string') return [];
        return [
          {
            section_key: item.section_key,
            chunk_index: item.chunk_index as number | string,
            item_count: item.item_count as number | string,
            chunk_sha256: String(item.chunk_sha256 ?? ''),
            items: item.items,
          },
        ];
      });
    };
    readyCoherentCount = 0;
    readyChunkCompleteCount = 0;
    if (semanticRows.length === readyCount) {
      for (const row of semanticRows) {
        const chunks = storedChunkRows(row.chunks);
        const chunksComplete = reviewChunksMatchPayload(row.payload, chunks);
        if (chunksComplete) readyChunkCompleteCount += 1;
        const semanticSha =
          chunksComplete && row.payload
            ? tournamentReviewSemanticSha256(row.payload, orderedReviewChunkHashes(chunks))
            : null;
        if (
          chunksComplete &&
          integerOrNull(row.ready_revision) !== null &&
          integerOrNull(row.ready_revision) === integerOrNull(row.head_revision) &&
          row.head_content_sha256 !== null &&
          row.head_content_sha256 === row.publication_content_sha256 &&
          semanticSha === row.head_content_sha256
        ) {
          readyCoherentCount += 1;
        }
      }
    }
  }
  const readyIncoherentCount = Math.max(0, readyCount - readyCoherentCount);
  const normalizedWatchEntryId =
    Number.isInteger(watchEntryId) && (watchEntryId ?? 0) > 0 ? watchEntryId : null;
  const watchedTournamentRows = normalizedWatchEntryId
    ? await db<Array<{ tournament_id: number }>>`
        WITH memberships AS (
          SELECT tournament_id
          FROM competition.tournament_entries
          WHERE season_id = ${season.seasonId} AND entry_id = ${normalizedWatchEntryId}
          UNION
          SELECT tournament.tournament_id
          FROM competition.entry_leagues entry_league
          JOIN competition.tournaments tournament
            ON tournament.season_id = entry_league.season_id
           AND tournament.league_id = entry_league.league_id
           AND tournament.league_type = entry_league.league_type
          WHERE entry_league.season_id = ${season.seasonId}
            AND entry_league.entry_id = ${normalizedWatchEntryId}
        )
        SELECT tournament_id
        FROM memberships
        ORDER BY tournament_id DESC
        LIMIT 100
      `
    : [];
  const watchedTournamentIds = watchedTournamentRows.map((row) => row.tournament_id);
  const watchRows = watchedTournamentIds.length
    ? await db<TournamentReviewOperationalWatchRow[]>`
        SELECT obligation.tournament_id,
               obligation.event_id,
               obligation.format,
               obligation.state,
               obligation.first_eligible_at,
               obligation.next_attempt_at,
               obligation.ready_revision,
               head.revision AS active_revision,
               publication.published_at,
               publication.event_data_checked_at,
               publication.source_max_checked_at,
               obligation.updated_at,
               obligation.last_error_code
        FROM competition.tournament_review_obligations obligation
        LEFT JOIN competition.tournament_review_heads head
          ON head.season_id = obligation.season_id
         AND head.tournament_id = obligation.tournament_id
         AND head.event_id = obligation.event_id
        LEFT JOIN competition.tournament_review_publications publication
          ON publication.season_id = obligation.season_id
         AND publication.tournament_id = obligation.tournament_id
         AND publication.event_id = obligation.event_id
         AND publication.revision = head.revision
        WHERE obligation.season_id = ${season.seasonId}
          AND obligation.tournament_id = ANY(${watchedTournamentIds}::int[])
        ORDER BY obligation.tournament_id DESC, obligation.event_id DESC
      `
    : [];
  const aggregate = aggregateRows[0];
  const watch = watchedTournamentIds.length
    ? {
        watchEntryId: normalizedWatchEntryId as number,
        tournaments: watchedTournamentIds.map((tournamentId) => ({
          tournamentId,
          scopes: watchRows
            .filter((row) => row.tournament_id === tournamentId)
            .map((row) => ({
              eventId: row.event_id,
              format: row.format,
              state: row.state,
              eligibleAt: dateIso(row.first_eligible_at) ?? now.toISOString(),
              nextAttemptAt: dateIso(row.next_attempt_at),
              revision: integerOrNull(row.active_revision),
              readyRevision: integerOrNull(row.ready_revision),
              publishedAt: dateIso(row.published_at),
              eventDataCheckedAt: dateIso(row.event_data_checked_at),
              sourceMaxCheckedAt: dateIso(row.source_max_checked_at),
              updatedAt: dateIso(row.updated_at) ?? now.toISOString(),
              lastErrorCode: row.last_error_code,
            })),
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
      readyWithCoherentHead: readyCoherentCount,
      readyWithIncoherentHead: readyIncoherentCount,
      readyWithIncompleteChunks: Math.max(0, readyCount - readyChunkCompleteCount),
    },
    oldestActiveEligibleAt: dateIso(aggregate?.oldest_active_eligible_at),
    oldestDegradedAt: dateIso(aggregate?.oldest_degraded_at),
    latestUpdatedAt: dateIso(aggregate?.latest_updated_at),
    watch,
  };
}

export function tournamentReviewFailureFingerprint(code: string, bucket: string): string {
  return reviewFingerprint(code, bucket);
}
