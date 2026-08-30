/* eslint-disable no-console */
import { createHash } from 'node:crypto';

import postgres from 'postgres';

import type { EventLive } from '../src/domain/event-lives';
import { validateEventLives } from '../src/domain/event-lives';
import { explicitSeasonRef, type FplSeasonRef } from '../src/domain/fpl-season';
import { validateFixtures } from '../src/domain/fixtures';
import {
  clearLiveCheckpointDesiredV2,
  entryLiveInputFromFplPicks,
  markLivePublicationCheckpointedV2,
  publishEntryLiveInputV2,
  publishLivePublicationV2,
  readEntryLiveInputV2,
  restoreLivePublicationV2Checkpoint,
  readLivePublicationV2,
  setEntryCheckpointDesiredV2,
  setLiveCheckpointDesiredV2,
  type EntryLiveInputV2,
  type Exactly15Picks,
  type LivePublicationState,
  type OfficialSubstitution,
} from '../src/cache/live-publication-v2';
import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton } from '../src/db/singleton';
import { isTransactionPoolerConnection } from '../src/db/postgres-connection';
import {
  checkpointLivePublicationV2,
  readLivePublicationV2Checkpoint,
} from '../src/services/live-publication-v2-checkpoint.service';
import { checkpointEntryLiveInputV2 } from '../src/services/entries.service';
import { canonicalJson, contentHash, postgresJsonbContentHash } from '../src/utils/content-hash';
import type { Fixture, RawFPLEntryEventPicksResponse } from '../src/types';

type TimestampValue = Date | string;

export type ExistingPickRow = {
  season_id: number;
  entry_id: number;
  event_id: number;
  position: number;
  element_id: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  chip: string | null;
  transfers: number | null;
  transfers_cost: number | null;
  source_created_at: TimestampValue;
  source_updated_at: TimestampValue;
};

export type SeedHead = {
  seasonId: number;
  entryId: number;
  eventId: number;
  publicationId: string;
  generation: number;
  picksBaseRevision: string;
  contentSha256: string;
  rowCount: 15;
  sourceCheckedAt: Date;
  contentUpdatedAt: Date;
  checkpointedAt: Date;
};

export type InvalidPickScope = {
  seasonId: number;
  entryId: number;
  eventId: number;
  observedRowCount: number;
  reasons: readonly string[];
};

export type SeedArguments = {
  readonly execute: boolean;
  readonly seedCache: boolean;
  /** Include every already-finalized event in addition to the requested live scope. */
  readonly allFinalized: boolean;
  readonly season: string | null;
  readonly eventId: number | null;
};

type LegacyLivePublicationRow = {
  publication_id: string;
  season_id: number;
  season_code: string;
  event_id: number;
  revision: number;
  manifest: unknown;
  event_live: unknown;
  fixtures: unknown;
  event_finished: boolean;
  event_data_checked: boolean;
  event_data_checked_at: TimestampValue | null;
  event_live_snapshot_finalized_at: TimestampValue | null;
  event_live_facts_persisted_at: TimestampValue | null;
  event_live_item_count: number | null;
  event_live_checksum: string | null;
  fixtures_item_count: number | null;
  fixtures_checksum: string | null;
};

export type PreviousTotalsRow = {
  entry_id: number;
  through_event_id: number;
  total_points: number;
  overall_rank: number | null;
};

export type FinalResultSeedRow = {
  entry_id: number;
  event_id: number;
  event_points: number;
  overall_points: number;
  event_picks: unknown;
  automatic_substitutions: unknown;
  rich_synced_at: TimestampValue | null;
  data_checked_at: TimestampValue | null;
};

export type ValidatedLiveSeed = {
  readonly source: LegacyLivePublicationRow;
  readonly season: FplSeasonRef;
  readonly state: LivePublicationState;
  readonly sourceCheckedAt: Date;
  readonly contentUpdatedAt: Date;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
};

export type InvalidLiveSeedScope = {
  readonly seasonId: number;
  readonly eventId: number;
  readonly publicationId: string | null;
  readonly reasons: readonly string[];
};

type LegacyManifestItem = {
  readonly name: string;
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseDate(value: unknown, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function nullableDateValue(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeEventLivePayload(value: unknown, eventId: number): EventLive[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) throw new Error('eventLive payload is not an array');
  const withDates = parsed.map((row) => {
    if (!isRecord(row)) return row;
    return {
      ...row,
      createdAt: nullableDateValue(row.createdAt),
    };
  });
  const eventLives = [...validateEventLives(withDates)];
  if (eventLives.length === 0) throw new Error('eventLive payload is empty');
  if (eventLives.some((row) => row.eventId !== eventId)) {
    throw new Error(`eventLive payload contains another event than ${eventId}`);
  }
  if (new Set(eventLives.map((row) => row.elementId)).size !== eventLives.length) {
    throw new Error('eventLive payload contains duplicate elements');
  }
  return eventLives;
}

function normalizeFixturePayload(value: unknown, eventId: number): Fixture[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) throw new Error('fixtures payload is not an array');
  const withDates = parsed.map((row) => {
    if (!isRecord(row)) return row;
    return {
      ...row,
      kickoffTime: nullableDateValue(row.kickoffTime),
      createdAt: nullableDateValue(row.createdAt),
      updatedAt: nullableDateValue(row.updatedAt),
    };
  });
  const fixtures = validateFixtures(withDates);
  if (fixtures.some((fixture) => fixture.event !== null && fixture.event !== eventId)) {
    throw new Error(`fixtures payload contains another event than ${eventId}`);
  }
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    throw new Error('fixtures payload contains duplicate fixture IDs');
  }
  return fixtures;
}

function legacyManifestItems(value: unknown): Map<string, LegacyManifestItem> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('legacy publication manifest has no item list');
  }
  const items = new Map<string, LegacyManifestItem>();
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.count !== 'number' ||
      !Number.isSafeInteger(item.count) ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      typeof item.sha256 !== 'string'
    ) {
      throw new Error('legacy publication manifest contains an invalid item');
    }
    if (items.has(item.name)) throw new Error(`legacy publication duplicates ${item.name}`);
    items.set(item.name, item as unknown as LegacyManifestItem);
  }
  if (items.size !== 2 || !items.has('eventLive') || !items.has('fixtures')) {
    throw new Error('legacy publication does not contain the complete live item set');
  }
  return items;
}

function legacyPublicationState(
  row: Pick<
    LegacyLivePublicationRow,
    'event_finished' | 'event_data_checked' | 'event_live_snapshot_finalized_at'
  >,
  manifest: Record<string, unknown>,
): LivePublicationState {
  if (
    row.event_finished &&
    row.event_data_checked &&
    nullableDateValue(row.event_live_snapshot_finalized_at) !== null
  ) {
    return 'FINALIZED';
  }
  if (row.event_finished && row.event_data_checked) return 'GW_REVIEW';
  if (manifest.state === 'scheduled') return 'PRE_DEADLINE';
  if (manifest.state === 'settled') return 'DAY_SETTLING';
  if (manifest.state === 'live') return 'LIVE_ACTIVE';
  throw new Error(`unsupported legacy live state: ${String(manifest.state)}`);
}

export function validateLegacyLiveSeed(
  row: LegacyLivePublicationRow,
): { ok: true; value: ValidatedLiveSeed } | { ok: false; value: InvalidLiveSeedScope } {
  const reasons = new Set<string>();
  let manifest: Record<string, unknown> | null = null;
  let eventLives: EventLive[] = [];
  let fixtures: Fixture[] = [];
  let sourceCheckedAt: Date | null = null;
  let contentUpdatedAt: Date | null = null;
  let state: LivePublicationState | null = null;
  try {
    const parsedManifest = jsonValue(row.manifest);
    if (!isRecord(parsedManifest)) throw new Error('legacy manifest is not an object');
    manifest = parsedManifest;
    if (manifest.dataset !== 'fpl:live') reasons.add('DATASET_NOT_FPL_LIVE');
    if (manifest.seasonCode !== row.season_code) reasons.add('SEASON_SCOPE_MISMATCH');
    if (manifest.eventId !== row.event_id) reasons.add('EVENT_SCOPE_MISMATCH');
    if (manifest.publicationId !== row.publication_id) reasons.add('PUBLICATION_ID_MISMATCH');
    if (!/^[0-9a-f-]{36}$/i.test(row.publication_id)) reasons.add('PUBLICATION_ID_INVALID');
    const items = legacyManifestItems(manifest);
    eventLives = normalizeEventLivePayload(row.event_live, row.event_id);
    fixtures = normalizeFixturePayload(row.fixtures, row.event_id);
    const eventLiveItem = items.get('eventLive')!;
    const fixtureItem = items.get('fixtures')!;
    if (eventLiveItem.count !== eventLives.length) reasons.add('EVENT_LIVE_COUNT_MISMATCH');
    if (fixtureItem.count !== fixtures.length) reasons.add('FIXTURE_COUNT_MISMATCH');
    if (row.event_live_item_count !== eventLives.length)
      reasons.add('EVENT_LIVE_ROW_COUNT_MISMATCH');
    if (row.fixtures_item_count !== fixtures.length) reasons.add('FIXTURE_ROW_COUNT_MISMATCH');
    if (row.event_live_checksum !== postgresJsonbContentHash(jsonValue(row.event_live)))
      reasons.add('EVENT_LIVE_SOURCE_CHECKSUM_MISMATCH');
    if (row.fixtures_checksum !== postgresJsonbContentHash(jsonValue(row.fixtures)))
      reasons.add('FIXTURE_SOURCE_CHECKSUM_MISMATCH');
    if (eventLiveItem.sha256 !== row.event_live_checksum)
      reasons.add('EVENT_LIVE_MANIFEST_CHECKSUM_MISMATCH');
    if (fixtureItem.sha256 !== row.fixtures_checksum)
      reasons.add('FIXTURE_MANIFEST_CHECKSUM_MISMATCH');
    contentUpdatedAt = parseDate(manifest.sourceCheckedAt, 'legacy sourceCheckedAt');
    sourceCheckedAt = parseDate(
      manifest.lastSuccessfulFetchAt ?? manifest.sourceCheckedAt,
      'legacy lastSuccessfulFetchAt',
    );
    const publishedAt = parseDate(manifest.publishedAt, 'legacy publishedAt');
    if (publishedAt.getTime() < sourceCheckedAt.getTime()) reasons.add('TIME_ORDER_INVALID');
    state = legacyPublicationState(row, manifest);
  } catch (error) {
    reasons.add(error instanceof Error ? error.message : 'LEGACY_PAYLOAD_INVALID');
  }
  if (reasons.size > 0 || !manifest || !sourceCheckedAt || !contentUpdatedAt || !state) {
    return {
      ok: false,
      value: {
        seasonId: row.season_id,
        eventId: row.event_id,
        publicationId: row.publication_id ?? null,
        reasons: [...reasons].sort(),
      },
    };
  }
  return {
    ok: true,
    value: {
      source: row,
      season: explicitSeasonRef(row.season_code),
      state,
      sourceCheckedAt,
      contentUpdatedAt,
      eventLives,
      fixtures,
    },
  };
}

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

function usage(): never {
  throw new Error(
    'usage: bun scripts/seed-live-points-v2.ts [--execute] [--cache] [--all-finalized] [--season YYYY] [--event-id N]',
  );
}

export function parseSeedArguments(argv: readonly string[]): SeedArguments {
  let execute = false;
  let seedCache = false;
  let allFinalized = false;
  let season: string | null = null;
  let eventId: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') {
      if (execute) usage();
      execute = true;
      continue;
    }
    if (token === '--cache') {
      if (seedCache) usage();
      seedCache = true;
      continue;
    }
    if (token === '--all-finalized') {
      if (allFinalized) usage();
      allFinalized = true;
      continue;
    }
    if (token === '--season') {
      const value = argv[++index];
      if (!value || !/^\d{4}$/.test(value) || season !== null) usage();
      season = value;
      continue;
    }
    if (token === '--event-id') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value <= 0 || eventId !== null) usage();
      eventId = value;
      continue;
    }
    usage();
  }
  if (seedCache && season === null) {
    throw new Error('--cache requires an explicit --season scope');
  }
  if (allFinalized && season === null) {
    throw new Error('--all-finalized requires an explicit --season scope');
  }
  return { execute, seedCache, allFinalized, season, eventId };
}

function asDate(value: TimestampValue): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function scopeKey(row: ExistingPickRow): string {
  return `${row.season_id}:${row.entry_id}:${row.event_id}`;
}

function sortRows(rows: readonly ExistingPickRow[]): ExistingPickRow[] {
  return [...rows].sort((left, right) => left.position - right.position);
}

export function inspectPickScope(rows: readonly ExistingPickRow[]): InvalidPickScope | null {
  const first = rows[0];
  if (!first) return null;
  const reasons = new Set<string>();
  const positions = rows.map((row) => row.position);
  const elements = rows.map((row) => row.element_id);
  if (rows.length !== 15) reasons.add('ROW_COUNT_NOT_15');
  if (
    new Set(positions).size !== rows.length ||
    positions.some((value) => value < 1 || value > 15)
  ) {
    reasons.add('POSITIONS_NOT_EXACT_1_TO_15');
  }
  if (new Set(elements).size !== rows.length || elements.some((value) => value <= 0)) {
    reasons.add('ELEMENTS_NOT_UNIQUE_POSITIVE');
  }
  if (rows.filter((row) => row.is_captain).length !== 1) reasons.add('CAPTAIN_NOT_UNIQUE');
  if (rows.filter((row) => row.is_vice_captain).length !== 1)
    reasons.add('VICE_CAPTAIN_NOT_UNIQUE');
  if (rows.some((row) => row.is_captain && row.is_vice_captain))
    reasons.add('CAPTAIN_ROLES_OVERLAP');
  if (
    rows.some(
      (row) => !Number.isInteger(row.multiplier) || row.multiplier < 0 || row.multiplier > 3,
    )
  ) {
    reasons.add('MULTIPLIER_INVALID');
  }
  if (rows.some((row) => row.multiplier > 1 && !row.is_captain && !row.is_vice_captain)) {
    reasons.add('UNMARKED_SCORING_BONUS');
  }
  if (rows.filter((row) => row.multiplier > 1).length > 1) reasons.add('SCORING_BONUS_NOT_UNIQUE');
  const positionOne = rows.filter((row) => row.position === 1);
  if (positionOne.length !== 1) reasons.add('POSITION_ONE_MISSING');
  if (
    rows.some((row) => row.position !== 1 && (row.chip !== null || row.transfers_cost !== null))
  ) {
    reasons.add('EVENT_METADATA_NOT_ON_POSITION_ONE');
  }
  for (const row of rows) {
    const createdAt = asDate(row.source_created_at);
    const updatedAt = asDate(row.source_updated_at);
    if (!createdAt || !updatedAt || updatedAt < createdAt) reasons.add('SOURCE_TIME_INVALID');
  }
  if (reasons.size === 0) return null;
  return {
    seasonId: first.season_id,
    entryId: first.entry_id,
    eventId: first.event_id,
    observedRowCount: rows.length,
    reasons: [...reasons].sort(),
  };
}

export function buildSeedHead(rows: readonly ExistingPickRow[]): SeedHead {
  const invalid = inspectPickScope(rows);
  if (invalid) {
    throw new Error(`Cannot seed invalid pick scope: ${invalid.reasons.join(',')}`);
  }
  const sorted = sortRows(rows);
  const first = sorted.find((row) => row.position === 1)!;
  const normalizedPicks = sorted.map((row) => ({
    element: row.element_id,
    position: row.position,
    multiplier: row.multiplier,
    isCaptain: row.is_captain,
    isViceCaptain: row.is_vice_captain,
  }));
  const contentSha256 = contentHash({
    picks: normalizedPicks,
    chip: first.chip,
    transferCount: first.transfers ?? 0,
    transferCost: first.transfers_cost ?? 0,
  });
  const sourceCheckedAt = sorted.reduce((latest, row) => {
    const updatedAt = asDate(row.source_updated_at);
    if (!updatedAt) throw new Error('A valid source_updated_at is required for every pick row');
    return updatedAt > latest ? updatedAt : latest;
  }, asDate(sorted[0]!.source_updated_at)!);
  const publicationId = createHash('sha256')
    .update(
      `live-points-v2-entry-seed:${first.season_id}:${first.entry_id}:${first.event_id}:${contentSha256}`,
    )
    .digest('hex');
  return {
    seasonId: first.season_id,
    entryId: first.entry_id,
    eventId: first.event_id,
    publicationId,
    generation: 1,
    picksBaseRevision: contentSha256,
    contentSha256,
    rowCount: 15,
    sourceCheckedAt,
    contentUpdatedAt: sourceCheckedAt,
    checkpointedAt: new Date(),
  };
}

function rowsToFplPicks(rows: readonly ExistingPickRow[]): RawFPLEntryEventPicksResponse {
  const sorted = sortRows(rows);
  const first = sorted[0]!;
  return {
    active_chip: first.chip,
    automatic_subs: [],
    entry_history: {
      event: first.event_id,
      points: 0,
      total_points: 0,
      rank: null,
      overall_rank: null,
      bank: 0,
      value: 0,
      event_transfers: first.transfers ?? 0,
      event_transfers_cost: first.transfers_cost ?? 0,
      points_on_bench: 0,
    },
    picks: sorted.map((row) => ({
      element: row.element_id,
      position: row.position,
      multiplier: row.multiplier,
      is_captain: row.is_captain,
      is_vice_captain: row.is_vice_captain,
    })),
  };
}

function normalizeFinalPicks(value: unknown): Exactly15Picks | null {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || parsed.length !== 15) return null;
  const picks = parsed.map((item) => {
    if (!isRecord(item)) return null;
    const element = item.element;
    const position = item.position;
    const multiplier = item.multiplier;
    const isCaptain = item.isCaptain ?? item.is_captain;
    const isViceCaptain = item.isViceCaptain ?? item.is_vice_captain;
    if (
      typeof element !== 'number' ||
      !Number.isSafeInteger(element) ||
      element <= 0 ||
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > 15 ||
      typeof multiplier !== 'number' ||
      !Number.isSafeInteger(multiplier) ||
      multiplier < 0 ||
      multiplier > 3 ||
      typeof isCaptain !== 'boolean' ||
      typeof isViceCaptain !== 'boolean' ||
      (isCaptain && isViceCaptain)
    ) {
      return null;
    }
    return { element, position, multiplier, isCaptain, isViceCaptain };
  });
  if (picks.some((pick) => pick === null)) return null;
  const normalized = picks as Exclude<(typeof picks)[number], null>[];
  if (
    new Set(normalized.map((pick) => pick.position)).size !== 15 ||
    new Set(normalized.map((pick) => pick.element)).size !== 15 ||
    normalized.filter((pick) => pick.isCaptain).length !== 1 ||
    normalized.filter((pick) => pick.isViceCaptain).length !== 1
  ) {
    return null;
  }
  return [...normalized].sort(
    (left, right) => left.position - right.position,
  ) as unknown as Exactly15Picks;
}

function normalizeFinalAutomaticSubs(
  value: unknown,
  allowedElements: ReadonlySet<number>,
): readonly OfficialSubstitution[] | null {
  const parsed = jsonValue(value);
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) return null;
  const incoming = new Set<number>();
  const outgoing = new Set<number>();
  const result: Array<{ inElement: number; outElement: number }> = [];
  for (const item of parsed) {
    if (!isRecord(item)) return null;
    const inElement = item.inElement ?? item.element_in;
    const outElement = item.outElement ?? item.element_out;
    if (
      typeof inElement !== 'number' ||
      !Number.isSafeInteger(inElement) ||
      typeof outElement !== 'number' ||
      !Number.isSafeInteger(outElement) ||
      inElement <= 0 ||
      outElement <= 0 ||
      inElement === outElement ||
      !allowedElements.has(inElement) ||
      !allowedElements.has(outElement) ||
      incoming.has(inElement) ||
      outgoing.has(outElement) ||
      incoming.has(outElement) ||
      outgoing.has(inElement)
    ) {
      return null;
    }
    incoming.add(inElement);
    outgoing.add(outElement);
    result.push({ inElement, outElement });
  }
  return result;
}

export function buildSeedInput(
  seasonCode: string,
  rows: readonly ExistingPickRow[],
  previousTotals: PreviousTotalsRow | null = null,
  finalResult: FinalResultSeedRow | null = null,
): { readonly input: EntryLiveInputV2; readonly sourceCheckedAt: Date } {
  const head = buildSeedHead(rows);
  const base = entryLiveInputFromFplPicks(
    explicitSeasonRef(seasonCode),
    head.eventId,
    head.entryId,
    rowsToFplPicks(rows),
    head.sourceCheckedAt,
  );
  const previous =
    previousTotals &&
    previousTotals.through_event_id > 0 &&
    previousTotals.total_points >= 0 &&
    (previousTotals.overall_rank === null || previousTotals.overall_rank > 0)
      ? {
          revision: contentHash({
            throughEventId: previousTotals.through_event_id,
            totalPoints: previousTotals.total_points,
            overallRank: previousTotals.overall_rank,
          }),
          throughEventId: previousTotals.through_event_id,
          totalPoints: previousTotals.total_points,
          overallRank: previousTotals.overall_rank,
        }
      : null;

  let sourceCheckedAt = head.sourceCheckedAt;
  let input: EntryLiveInputV2 = { ...base, previousTotals: previous };
  if (finalResult) {
    const dataCheckedAt = nullableDateValue(finalResult.data_checked_at);
    const richSyncedAt = nullableDateValue(finalResult.rich_synced_at);
    const finalPicks = normalizeFinalPicks(finalResult.event_picks);
    const finalAutomaticSubs = finalPicks
      ? normalizeFinalAutomaticSubs(
          finalResult.automatic_substitutions,
          new Set(finalPicks.map((pick) => pick.element)),
        )
      : null;
    if (
      dataCheckedAt &&
      richSyncedAt &&
      richSyncedAt.getTime() >= dataCheckedAt.getTime() &&
      finalPicks &&
      finalAutomaticSubs !== null &&
      finalResult.event_id === head.eventId &&
      finalResult.event_points >= 0 &&
      finalResult.overall_points >= 0
    ) {
      sourceCheckedAt =
        richSyncedAt.getTime() > sourceCheckedAt.getTime() ? richSyncedAt : sourceCheckedAt;
      const score = {
        eventPoints: finalResult.event_points,
        totalPoints: finalResult.overall_points,
      };
      const finalPayload = {
        score,
        picks: finalPicks,
        automaticSubs: finalAutomaticSubs,
      };
      const finalRevision = contentHash({
        dataCheckedAt: dataCheckedAt.toISOString(),
        ...finalPayload,
      });
      input = {
        ...input,
        officialAdjustment: {
          revision: contentHash({
            dataCheckedAt: dataCheckedAt.toISOString(),
            multipliers: finalPicks.map((pick) => ({
              element: pick.element,
              multiplier: pick.multiplier,
            })),
            automaticSubs: finalAutomaticSubs,
          }),
          multipliers: finalPicks.map((pick) => ({
            element: pick.element,
            multiplier: pick.multiplier,
          })),
          automaticSubs: finalAutomaticSubs,
        },
        finalResult: {
          revision: finalRevision,
          score,
          picks: finalPicks,
          automaticSubs: finalAutomaticSubs,
        },
      };
    }
  }
  return { input, sourceCheckedAt };
}

async function loadRows(database: postgres.Sql, args: SeedArguments): Promise<ExistingPickRow[]> {
  const predicates = ['TRUE'];
  const parameters: Array<string | number> = [];
  if (args.season !== null) {
    parameters.push(args.season);
    predicates.push(`season.season_code = $${parameters.length}`);
  }
  if (args.eventId !== null) {
    parameters.push(args.eventId);
    predicates.push(`p.event_id = $${parameters.length}`);
  }
  const query = `
    SELECT
      p.season_id,
      p.entry_id,
      p.event_id,
      p.position,
      p.element_id,
      p.multiplier,
      p.is_captain,
      p.is_vice_captain,
      p.active_chip::text AS chip,
      p.transfers,
      p.transfers_cost,
      p.source_created_at,
      p.source_updated_at
    FROM competition.entry_event_picks p
    JOIN fpl.seasons season ON season.season_id = p.season_id
    WHERE ${predicates.join(' AND ')}
    ORDER BY p.season_id, p.entry_id, p.event_id, p.position
  `;
  return database.unsafe<ExistingPickRow[]>(query, parameters);
}

async function loadLegacyLivePublications(
  database: postgres.Sql,
  args: SeedArguments,
): Promise<LegacyLivePublicationRow[]> {
  const parameters: Array<string | number> = ['fpl:live', 'active', 'eventLive', 'fixtures'];
  const predicates = [
    'publication.dataset = $1',
    'publication.status = $2',
    'event_item.item_name = $3',
    'fixture_item.item_name = $4',
  ];
  if (args.season !== null) {
    parameters.push(args.season);
    predicates.push(`season.season_code = $${parameters.length}`);
  }
  if (args.eventId !== null) {
    parameters.push(args.eventId);
    predicates.push(
      args.allFinalized
        ? `(publication.event_id = $${parameters.length}
            OR (event.finished = TRUE
                AND event.data_checked = TRUE
                AND event.live_snapshot_finalized_at IS NOT NULL))`
        : `publication.event_id = $${parameters.length}`,
    );
  } else if (args.allFinalized) {
    predicates.push(
      `event.finished = TRUE
       AND event.data_checked = TRUE
       AND event.live_snapshot_finalized_at IS NOT NULL`,
    );
  }
  return database.unsafe<LegacyLivePublicationRow[]>(
    `
      SELECT
        publication.publication_id,
        publication.season_id,
        season.season_code,
        publication.event_id,
        publication.revision,
        publication.manifest,
        event_item.payload AS event_live,
        fixture_item.payload AS fixtures,
        event.finished AS event_finished,
        event.data_checked AS event_data_checked,
        event.data_checked_at AS event_data_checked_at,
        event.live_snapshot_finalized_at AS event_live_snapshot_finalized_at,
        event.live_facts_persisted_at AS event_live_facts_persisted_at,
        event_item.item_count AS event_live_item_count,
        event_item.checksum AS event_live_checksum,
        fixture_item.item_count AS fixtures_item_count,
        fixture_item.checksum AS fixtures_checksum
      FROM ops.dataset_publications publication
      JOIN fpl.seasons season
        ON season.season_id = publication.season_id
      JOIN fpl.events event
        ON event.season_id = publication.season_id
       AND event.event_id = publication.event_id
      JOIN ops.dataset_publication_items event_item
        ON event_item.publication_id = publication.publication_id
      JOIN ops.dataset_publication_items fixture_item
        ON fixture_item.publication_id = publication.publication_id
      WHERE ${predicates.join(' AND ')}
      ORDER BY publication.season_id, publication.event_id, publication.revision DESC
    `,
    parameters,
  );
}

async function loadFinalizedEventIds(
  database: postgres.Sql,
  season: FplSeasonRef,
): Promise<number[]> {
  const rows = await database.unsafe<{ event_id: number }[]>(
    `
      SELECT event_id
      FROM fpl.events
      WHERE season_id = $1
        AND finished = TRUE
        AND data_checked = TRUE
        AND live_snapshot_finalized_at IS NOT NULL
      ORDER BY event_id
    `,
    [season.seasonId],
  );
  return rows.map((row) => row.event_id);
}

async function loadExistingV2EventIds(
  database: postgres.Sql,
  season: FplSeasonRef,
): Promise<Set<number>> {
  const rows = await database.unsafe<{ event_id: number }[]>(
    `
      SELECT event_id
      FROM competition.live_points_publication_checkpoints
      WHERE season_id = $1
        AND state = 'FINALIZED'
      ORDER BY event_id
    `,
    [season.seasonId],
  );
  return new Set(rows.map((row) => row.event_id));
}

async function hasExistingV2LiveCheckpoint(
  database: postgres.Sql,
  args: SeedArguments,
): Promise<boolean> {
  const parameters: Array<string | number> = [];
  const predicates = ['TRUE'];
  if (args.season !== null) {
    parameters.push(args.season);
    predicates.push(`season.season_code = $${parameters.length}`);
  }
  if (args.eventId !== null) {
    parameters.push(args.eventId);
    predicates.push(`checkpoint.event_id = $${parameters.length}`);
  }
  const [row] = await database.unsafe<{ exists: boolean }[]>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM competition.live_points_publication_checkpoints checkpoint
        JOIN fpl.seasons season ON season.season_id = checkpoint.season_id
        WHERE ${predicates.join(' AND ')}
      ) AS exists
    `,
    parameters,
  );
  return row?.exists === true;
}

async function loadPreviousTotals(
  database: postgres.Sql,
  season: FplSeasonRef,
  eventId: number,
): Promise<PreviousTotalsRow[]> {
  return database.unsafe<PreviousTotalsRow[]>(
    `
      SELECT DISTINCT ON (result.entry_id)
        result.entry_id,
        result.event_id AS through_event_id,
        result.overall_points AS total_points,
        NULLIF(result.overall_rank, 0) AS overall_rank
      FROM competition.entry_event_results result
      JOIN competition.entries entry
        ON entry.season_id = result.season_id
       AND entry.entry_id = result.entry_id
      JOIN fpl.events event
        ON event.season_id = result.season_id
       AND event.event_id = result.event_id
      WHERE result.season_id = $1
        AND result.event_id < $2
        AND result.event_id >= COALESCE(entry.started_event, 1)
        AND event.finished = TRUE
        AND event.data_checked = TRUE
        AND event.data_checked_at IS NOT NULL
        AND result.rich_synced_at IS NOT NULL
        AND result.rich_synced_at >= event.data_checked_at
      ORDER BY result.entry_id, result.event_id DESC
    `,
    [season.seasonId, eventId],
  );
}

async function loadFinalResults(
  database: postgres.Sql,
  season: FplSeasonRef,
  eventId: number,
): Promise<FinalResultSeedRow[]> {
  return database.unsafe<FinalResultSeedRow[]>(
    `
      SELECT
        result.entry_id,
        result.event_id,
        result.event_points,
        result.overall_points,
        result.event_picks,
        result.automatic_substitutions,
        result.rich_synced_at,
        event.data_checked_at
      FROM competition.entry_event_results result
      JOIN fpl.events event
        ON event.season_id = result.season_id
       AND event.event_id = result.event_id
      WHERE result.season_id = $1
        AND result.event_id = $2
        AND event.finished = TRUE
        AND event.data_checked = TRUE
        AND result.rich_synced_at IS NOT NULL
      ORDER BY result.entry_id, result.updated_at DESC
    `,
    [season.seasonId, eventId],
  );
}

function groupRows(rows: readonly ExistingPickRow[]): ExistingPickRow[][] {
  const groups = new Map<string, ExistingPickRow[]>();
  for (const row of rows) {
    const group = groups.get(scopeKey(row));
    if (group) group.push(row);
    else groups.set(scopeKey(row), [row]);
  }
  return [...groups.values()];
}

function placeholders(rowCount: number, columnCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * columnCount;
    return `(${Array.from({ length: columnCount }, (_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
  }).join(', ');
}

function repairPlaceholders(rowCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * 5;
    return `(${Array.from({ length: 5 }, (_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')}, now(), 'PENDING', NULL, NULL)`;
  }).join(', ');
}

async function writeHeads(database: SqlExecutor, heads: readonly SeedHead[]): Promise<void> {
  for (let offset = 0; offset < heads.length; offset += 500) {
    const batch = heads.slice(offset, offset + 500);
    const values = batch.flatMap((head) => [
      head.seasonId,
      head.entryId,
      head.eventId,
      head.publicationId,
      head.generation,
      head.picksBaseRevision,
      head.contentSha256,
      head.rowCount,
      head.sourceCheckedAt,
      head.contentUpdatedAt,
      head.checkpointedAt,
      'COMPLETE',
    ]);
    await database.unsafe(
      `
        INSERT INTO competition.entry_event_pick_heads
          (season_id, entry_id, event_id, publication_id, generation,
           picks_base_revision, content_sha256, row_count, source_checked_at,
           content_updated_at, checkpointed_at, state)
        VALUES ${placeholders(batch.length, 12)}
        ON CONFLICT (season_id, entry_id, event_id) DO UPDATE SET
          publication_id = EXCLUDED.publication_id,
          generation = EXCLUDED.generation,
          picks_base_revision = EXCLUDED.picks_base_revision,
          content_sha256 = EXCLUDED.content_sha256,
          row_count = EXCLUDED.row_count,
          source_checked_at = EXCLUDED.source_checked_at,
          content_updated_at = EXCLUDED.content_updated_at,
          checkpointed_at = EXCLUDED.checkpointed_at,
          state = EXCLUDED.state
        WHERE competition.entry_event_pick_heads.generation < EXCLUDED.generation
      `,
      values,
    );
  }
}

async function writeRepairs(
  database: SqlExecutor,
  repairs: readonly InvalidPickScope[],
): Promise<void> {
  for (let offset = 0; offset < repairs.length; offset += 500) {
    const batch = repairs.slice(offset, offset + 500);
    const values = batch.flatMap((repair) => [
      repair.seasonId,
      repair.entryId,
      repair.eventId,
      repair.reasons.join(','),
      repair.observedRowCount,
    ]);
    await database.unsafe(
      `
        INSERT INTO competition.entry_event_pick_repairs
          (season_id, entry_id, event_id, reason, observed_row_count,
           observed_at, status, last_attempt_at, resolved_at)
        VALUES ${repairPlaceholders(batch.length)}
        ON CONFLICT (season_id, entry_id, event_id) DO UPDATE SET
          reason = EXCLUDED.reason,
          observed_row_count = EXCLUDED.observed_row_count,
          observed_at = EXCLUDED.observed_at,
          status = 'PENDING',
          last_attempt_at = NULL,
          resolved_at = NULL
      `,
      values,
    );
  }
}

function sameLiveSeed(
  read: Awaited<ReturnType<typeof readLivePublicationV2>>,
  seed: ValidatedLiveSeed,
): boolean {
  return Boolean(
    read &&
      read.servedFrom === 'REDIS_CURRENT' &&
      read.publication.state === seed.state &&
      canonicalJson(read.eventLives) === canonicalJson(seed.eventLives) &&
      canonicalJson(read.fixtures) === canonicalJson(seed.fixtures),
  );
}

function sameEntrySeed(
  read: Awaited<ReturnType<typeof readEntryLiveInputV2>>,
  input: EntryLiveInputV2,
): boolean {
  return Boolean(
    read &&
      read.servedFrom === 'REDIS_CURRENT' &&
      canonicalJson(read.input) === canonicalJson(input),
  );
}

async function checkpointSeededLive(
  seed: ValidatedLiveSeed,
  publication: Awaited<ReturnType<typeof publishLivePublicationV2>>['publication'],
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  payload: Pick<ValidatedLiveSeed, 'eventLives' | 'fixtures'> = seed,
): Promise<'checkpointed' | 'already-checkpointed' | 'blocked'> {
  // Redis metadata is not durable proof.  A rebuilt Redis can retain a
  // checkpointedAt value after the PostgreSQL checkpoint row was lost, so
  // verify the durable identity before declaring an existing publication
  // repaired.  If PostgreSQL has a different durable winner, restore that
  // exact publication instead of silently accepting the conflicting Redis
  // pointer.
  const durable = await readLivePublicationV2Checkpoint(seed.season, seed.source.event_id);
  if (publication.checkpointedAt !== null) {
    if (
      durable &&
      durable.publication.publicationId === publication.publicationId &&
      durable.publication.generation === publication.generation
    ) {
      return 'already-checkpointed';
    }
    if (durable) {
      const restored = await restoreLivePublicationV2Checkpoint({ checkpoint: durable, redis });
      if (
        !restored.published &&
        (restored.publication.publicationId !== durable.publication.publicationId ||
          restored.publication.generation !== durable.publication.generation)
      ) {
        return 'blocked';
      }
      return 'already-checkpointed';
    }
  }
  const desired = await setLiveCheckpointDesiredV2(publication, new Date(), redis);
  const checkpointed = await checkpointLivePublicationV2({
    season: seed.season,
    eventId: seed.source.event_id,
    publication,
    eventLives: payload.eventLives,
    fixtures: payload.fixtures,
  });
  if (!checkpointed) {
    // A seed candidate may lose to a newer or FINALIZED durable head. Never
    // mark that rejected candidate durable; restore the accepted checkpoint so
    // the seed cannot leave Redis serving an older publication.
    const winner = await readLivePublicationV2Checkpoint(seed.season, seed.source.event_id);
    if (!winner) return 'blocked';
    const restored = await restoreLivePublicationV2Checkpoint({ checkpoint: winner, redis });
    if (
      !restored.published &&
      (restored.publication.publicationId !== winner.publication.publicationId ||
        restored.publication.generation !== winner.publication.generation)
    ) {
      return 'blocked';
    }
    await clearLiveCheckpointDesiredV2(desired, redis);
    return 'already-checkpointed';
  }
  const marked = await markLivePublicationCheckpointedV2(publication, new Date(), redis);
  if (marked) {
    await clearLiveCheckpointDesiredV2(desired, redis);
    return 'checkpointed';
  }
  return 'blocked';
}

async function seedLivePublication(
  seed: ValidatedLiveSeed,
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<{
  readonly status: 'published' | 'unchanged' | 'stale' | 'restored' | 'skipped-existing';
  readonly checkpoint: 'checkpointed' | 'already-checkpointed' | 'blocked' | 'not-required';
  readonly generation: number;
  readonly publicationId: string;
}> {
  const scope = { season: seed.season.seasonCode, eventId: seed.source.event_id } as const;
  const current = await readLivePublicationV2(scope, redis);
  if (sameLiveSeed(current, seed)) {
    const checkpoint = await checkpointSeededLive(seed, current!.publication, redis);
    return {
      status: 'unchanged',
      checkpoint,
      generation: current!.publication.generation,
      publicationId: current!.publication.publicationId,
    };
  }
  if (current) {
    // A deploy seed is a cutover/bootstrap operation, not a periodic writer.
    // Once any V2 publication is readable (including a previous fallback), a
    // legacy snapshot must never replace the live generation on a later deploy.
    const checkpoint = await checkpointSeededLive(seed, current.publication, redis, {
      eventLives: current.eventLives,
      fixtures: current.fixtures,
    });
    return {
      status: 'skipped-existing',
      checkpoint,
      generation: current.publication.generation,
      publicationId: current.publication.publicationId,
    };
  }
  const durable = await readLivePublicationV2Checkpoint(seed.season, seed.source.event_id);
  if (durable) {
    // Redis may have lost its pointer after the first cutover. Restore the
    // exact durable identity rather than manufacturing a new publication from
    // legacy rows (especially important for FINALIZED events).
    const restored = await restoreLivePublicationV2Checkpoint({
      checkpoint: durable,
      redis,
    });
    if (
      !restored.published &&
      (restored.publication.publicationId !== durable.publication.publicationId ||
        restored.publication.generation !== durable.publication.generation)
    ) {
      return {
        status: 'stale',
        checkpoint: 'blocked',
        generation: restored.publication.generation,
        publicationId: restored.publication.publicationId,
      };
    }
    return {
      status: 'restored',
      checkpoint: 'already-checkpointed',
      generation: restored.publication.generation,
      publicationId: restored.publication.publicationId,
    };
  }
  const promoted = await publishLivePublicationV2({
    season: seed.season.seasonCode,
    eventId: seed.source.event_id,
    state: seed.state,
    sourceCheckedAt: seed.sourceCheckedAt,
    contentUpdatedAt: seed.contentUpdatedAt,
    eventLives: seed.eventLives,
    fixtures: seed.fixtures,
    previous: null,
    redis,
  });
  if (!promoted.published) {
    return {
      status: 'stale',
      checkpoint: 'not-required',
      generation: promoted.publication.generation,
      publicationId: promoted.publication.publicationId,
    };
  }
  const checkpoint = await checkpointSeededLive(seed, promoted.publication, redis);
  return {
    status: 'published',
    checkpoint,
    generation: promoted.publication.generation,
    publicationId: promoted.publication.publicationId,
  };
}

async function readEntryGenerationFloor(
  database: postgres.Sql,
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
): Promise<number> {
  const rows = await database<{ generation: number | string }[]>`
    SELECT generation
    FROM competition.entry_event_pick_heads
    WHERE season_id = ${season.seasonId}
      AND entry_id = ${entryId}
      AND event_id = ${eventId}
      AND row_count = 15
      AND state = 'COMPLETE'
    LIMIT 1
  `;
  const generation = Number(rows[0]?.generation ?? 0);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

async function seedEntryInput(
  season: FplSeasonRef,
  rows: readonly ExistingPickRow[],
  previousTotals: PreviousTotalsRow | null,
  finalResult: FinalResultSeedRow | null,
  database: postgres.Sql,
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<{
  readonly status: 'published' | 'unchanged' | 'stale';
  readonly checkpoint: 'checkpointed' | 'already-checkpointed' | 'blocked' | 'not-required';
  readonly entryId: number;
  readonly generation: number;
  readonly publicationId: string;
  readonly final: boolean;
}> {
  const first = rows[0]!;
  const { input, sourceCheckedAt } = buildSeedInput(
    season.seasonCode,
    rows,
    previousTotals,
    finalResult,
  );
  const scope = {
    season: season.seasonCode,
    eventId: first.event_id,
    entryId: first.entry_id,
  } as const;
  const current = await readEntryLiveInputV2(scope, redis);
  if (sameEntrySeed(current, input)) {
    // Replaying the exact Redis input is also the repair path for a seed that
    // wrote a synthetic/older SQL head before the Redis publication existed.
    // Reconcile the durable head even when Redis already marks this input
    // checkpointed; the operation is idempotent and does not create a new
    // publication generation.
    await setEntryCheckpointDesiredV2(current!.publication, new Date(), redis);
    const result = await checkpointEntryLiveInputV2(season, first.event_id, first.entry_id);
    return {
      status: 'unchanged',
      checkpoint:
        result === 'checkpointed'
          ? 'checkpointed'
          : current!.publication.checkpointedAt !== null
            ? 'already-checkpointed'
            : 'blocked',
      entryId: first.entry_id,
      generation: current!.publication.generation,
      publicationId: current!.publication.publicationId,
      final: input.finalResult !== null,
    };
  }
  if (current) {
    // Any readable V2 entry input is authoritative after cutover. Never
    // replace it with a legacy seed merely because the legacy content differs;
    // repair/checkpoint the retained V2 input instead.
    await setEntryCheckpointDesiredV2(current.publication, new Date(), redis);
    const result = await checkpointEntryLiveInputV2(season, first.event_id, first.entry_id);
    return {
      status: 'unchanged',
      checkpoint:
        result === 'checkpointed'
          ? 'checkpointed'
          : current.publication.checkpointedAt !== null
            ? 'already-checkpointed'
            : 'blocked',
      entryId: first.entry_id,
      generation: current.publication.generation,
      publicationId: current.publication.publicationId,
      final: current.publication.state === 'FINAL',
    };
  }
  const generationFloor = await readEntryGenerationFloor(
    database,
    season,
    first.entry_id,
    first.event_id,
  );
  const promoted = await publishEntryLiveInputV2({
    season: season.seasonCode,
    eventId: first.event_id,
    entryId: first.entry_id,
    input,
    sourceCheckedAt,
    generationFloor,
    redis,
  });
  if (!promoted.published) {
    return {
      status: 'stale',
      checkpoint: 'not-required',
      entryId: first.entry_id,
      generation: promoted.publication.generation,
      publicationId: promoted.publication.publicationId,
      final: promoted.publication.state === 'FINAL',
    };
  }
  await setEntryCheckpointDesiredV2(promoted.publication, new Date(), redis);
  const result = await checkpointEntryLiveInputV2(season, first.event_id, first.entry_id);
  return {
    status: 'published',
    checkpoint: result === 'checkpointed' ? 'checkpointed' : 'blocked',
    entryId: first.entry_id,
    generation: promoted.publication.generation,
    publicationId: promoted.publication.publicationId,
    final: input.finalResult !== null,
  };
}

async function main(): Promise<void> {
  const args = parseSeedArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (isTransactionPoolerConnection(databaseUrl)) {
    throw new Error('V2 seed requires direct PostgreSQL or a session-mode pooler connection');
  }
  if (args.execute && process.env.LIVE_POINTS_SEED_CONFIRM !== 'YES') {
    throw new Error('seed writes refused: set LIVE_POINTS_SEED_CONFIRM=YES for this exact command');
  }

  const database = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await loadRows(database, args);
    const heads: SeedHead[] = [];
    const repairs: InvalidPickScope[] = [];
    const rowGroups = groupRows(rows);
    for (const group of rowGroups) {
      const invalid = inspectPickScope(group);
      if (invalid) repairs.push(invalid);
      else heads.push(buildSeedHead(group));
    }

    const cacheCandidates: ValidatedLiveSeed[] = [];
    const cacheInvalid: InvalidLiveSeedScope[] = [];
    if (args.seedCache) {
      const legacyPublications = await loadLegacyLivePublications(database, args);
      for (const legacyPublication of legacyPublications) {
        const validated = validateLegacyLiveSeed(legacyPublication);
        if (validated.ok) cacheCandidates.push(validated.value);
        else cacheInvalid.push(validated.value);
      }
      const duplicateScopes = new Set<string>();
      for (const seed of cacheCandidates) {
        const key = `${seed.season.seasonCode}:${seed.source.event_id}`;
        if (duplicateScopes.has(key)) {
          cacheInvalid.push({
            seasonId: seed.source.season_id,
            eventId: seed.source.event_id,
            publicationId: seed.source.publication_id,
            reasons: ['DUPLICATE_ACTIVE_SCOPE'],
          });
        }
        duplicateScopes.add(key);
      }
      if (args.execute && cacheInvalid.length > 0) {
        throw new Error(
          `V2 cache seed refused because ${cacheInvalid.length} legacy live publication scope(s) failed validation`,
        );
      }
      if (args.execute && args.allFinalized) {
        const season = explicitSeasonRef(args.season!);
        const [finalizedEventIds, existingV2EventIds] = await Promise.all([
          loadFinalizedEventIds(database, season),
          loadExistingV2EventIds(database, season),
        ]);
        const candidateEventIds = new Set(
          cacheCandidates
            .filter((candidate) => candidate.state === 'FINALIZED')
            .map((candidate) => candidate.source.event_id),
        );
        const missingEventIds = finalizedEventIds.filter(
          (eventId) => !candidateEventIds.has(eventId) && !existingV2EventIds.has(eventId),
        );
        if (missingEventIds.length > 0) {
          throw new Error(
            `V2 cache seed refused because finalized event scopes are missing: ${missingEventIds.join(',')}`,
          );
        }
      }
      if (
        args.execute &&
        cacheCandidates.length === 0 &&
        !(await hasExistingV2LiveCheckpoint(database, args))
      ) {
        throw new Error(
          'V2 cache seed refused because no complete legacy live publication was found',
        );
      }
    }
    if (args.execute) {
      await database.begin(async (transaction) => {
        await writeHeads(transaction, heads);
        await writeRepairs(transaction, repairs);
      });
    }

    const cacheResults: Array<Record<string, unknown>> = [];
    const entryResults: Array<Record<string, unknown>> = [];
    if (args.seedCache && args.execute) {
      const redis = await redisSingleton.getClient();
      try {
        for (const seed of cacheCandidates) {
          const globalResult = await seedLivePublication(seed, redis);
          cacheResults.push({
            season: seed.season.seasonCode,
            eventId: seed.source.event_id,
            ...globalResult,
          });

          const previousTotals = await loadPreviousTotals(
            database,
            seed.season,
            seed.source.event_id,
          );
          const previousTotalsByEntry = new Map(
            previousTotals.map((row) => [row.entry_id, row] as const),
          );
          const finalResults = await loadFinalResults(database, seed.season, seed.source.event_id);
          const finalResultsByEntry = new Map(
            finalResults.map((row) => [row.entry_id, row] as const),
          );
          const eventGroups = rowGroups.filter(
            (group) =>
              group[0]?.season_id === seed.source.season_id &&
              group[0]?.event_id === seed.source.event_id,
          );
          for (const group of eventGroups) {
            if (inspectPickScope(group)) continue;
            const entryResult = await seedEntryInput(
              seed.season,
              group,
              previousTotalsByEntry.get(group[0]!.entry_id) ?? null,
              finalResultsByEntry.get(group[0]!.entry_id) ?? null,
              database,
              redis,
            );
            entryResults.push({
              season: seed.season.seasonCode,
              eventId: seed.source.event_id,
              ...entryResult,
            });
          }
        }
        const blockedGlobalResults = cacheResults.filter(
          (result) =>
            result.checkpoint !== 'checkpointed' && result.checkpoint !== 'already-checkpointed',
        );
        const blockedEntryResults = entryResults.filter(
          (result) =>
            result.checkpoint !== 'checkpointed' && result.checkpoint !== 'already-checkpointed',
        );
        if (blockedGlobalResults.length > 0 || blockedEntryResults.length > 0) {
          throw new Error(
            `V2 cache seed refused because ${blockedGlobalResults.length} global and ${blockedEntryResults.length} entry checkpoint result(s) did not converge`,
          );
        }
        if (args.allFinalized) {
          const season = explicitSeasonRef(args.season!);
          const finalizedEventIds = await loadFinalizedEventIds(database, season);
          const unavailableEventIds: number[] = [];
          for (const eventId of finalizedEventIds) {
            const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
            const active = await readLivePublicationV2(
              { season: season.seasonCode, eventId },
              redis,
            );
            if (
              !checkpoint ||
              checkpoint.publication.state !== 'FINALIZED' ||
              !active ||
              active.servedFrom !== 'REDIS_CURRENT' ||
              active.publication.state !== 'FINALIZED' ||
              active.publication.publicationId !== checkpoint.publication.publicationId ||
              active.publication.generation !== checkpoint.publication.generation
            ) {
              unavailableEventIds.push(eventId);
            }
          }
          if (unavailableEventIds.length > 0) {
            throw new Error(
              `V2 cache seed refused because finalized scopes are not durably served: ${unavailableEventIds.join(',')}`,
            );
          }
        }
      } finally {
        await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
      }
    }
    console.log(
      JSON.stringify(
        {
          operation: 'seed-live-points-v2',
          executed: args.execute,
          seedCache: args.seedCache,
          allFinalized: args.allFinalized,
          season: args.season,
          eventId: args.eventId,
          sourceRows: rows.length,
          scopes: heads.length + repairs.length,
          validHeads: heads.length,
          repairScopes: repairs.length,
          repairSample: repairs.slice(0, 20),
          cacheCandidates: cacheCandidates.length,
          cacheInvalid: cacheInvalid.length,
          cacheInvalidSample: cacheInvalid.slice(0, 20),
          cacheResults,
          entryResults: entryResults.slice(0, 20),
          entryResultCount: entryResults.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await database.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[seed-live-points-v2] failed', error);
    process.exitCode = 1;
  });
}
