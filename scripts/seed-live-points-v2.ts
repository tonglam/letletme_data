/* eslint-disable no-console */
import { createHash } from 'node:crypto';

import postgres from 'postgres';

import { isTransactionPoolerConnection } from '../src/db/postgres-connection';
import { contentHash } from '../src/utils/content-hash';

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
  readonly season: string | null;
  readonly eventId: number | null;
};

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

function usage(): never {
  throw new Error(
    'usage: bun scripts/seed-live-points-v2.ts [--execute] [--season YYYY] [--event-id N]',
  );
}

export function parseSeedArguments(argv: readonly string[]): SeedArguments {
  let execute = false;
  let season: string | null = null;
  let eventId: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') {
      if (execute) usage();
      execute = true;
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
  return { execute, season, eventId };
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
    ]);
    await database.unsafe(
      `
        INSERT INTO competition.entry_event_pick_heads
          (season_id, entry_id, event_id, publication_id, generation,
           picks_base_revision, content_sha256, row_count, source_checked_at,
           content_updated_at, checkpointed_at, state)
        VALUES ${placeholders(batch.length, 11).replaceAll('$', '$')}
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
        WHERE competition.entry_event_pick_heads.generation <= EXCLUDED.generation
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
    for (const group of groupRows(rows)) {
      const invalid = inspectPickScope(group);
      if (invalid) repairs.push(invalid);
      else heads.push(buildSeedHead(group));
    }
    if (args.execute) {
      await database.begin(async (transaction) => {
        await writeHeads(transaction, heads);
        await writeRepairs(transaction, repairs);
      });
    }
    console.log(
      JSON.stringify(
        {
          operation: 'seed-live-points-v2',
          executed: args.execute,
          season: args.season,
          eventId: args.eventId,
          sourceRows: rows.length,
          scopes: heads.length + repairs.length,
          validHeads: heads.length,
          repairScopes: repairs.length,
          repairSample: repairs.slice(0, 20),
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
