import type postgres from 'postgres';

import { redisSingleton } from '../cache/singleton';
import { getDbClient } from '../db/singleton';
import {
  EVENT_LIVE_PROJECTION_ALGORITHM_VERSION,
  isEffectiveLineup,
  type EffectiveLineupRow,
} from '../domain/event-live-manager-projection';
import type { FplSeasonRef } from '../domain/fpl-season';
import { contentHash } from '../utils/content-hash';
import { logWarn } from '../utils/logger';

export type ManagerScoreMaterializationInput = Readonly<{
  entryId: number;
  inputRevision: string;
  scoreRevision: string;
  calculationMode: 'PROJECTED_AUTOSUBS';
  algorithmVersion: string | null;
  scoreSource: 'FPL_EVENT_LIVE';
  livePublicationId: string;
  liveRevision: string;
  liveCheckedAt: string;
  picksRevision: string;
  picksCheckedAt: string;
  previousTotalsRevision: string;
  previousTotalsThroughEventId: number | null;
  resultRevision?: string | null;
  resultCheckedAt?: string | null;
  dataCheckedAt?: string | null;
  rankRevision?: string | null;
  rankSource?: 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | null;
  rankCheckedAt?: string | null;
  eventPoints: number;
  netEventPoints: number;
  totalPoints: number | null;
  transferCost: number;
  effectiveLineup: readonly EffectiveLineupRow[] | null;
}>;

export type ManagerScoreMaterializationResult = Readonly<{
  materializationsWritten: number;
  headsUpdated: number;
  headsRejected: number;
}>;

export type ManagerScoreHeadReadResult = Readonly<{
  rows: ManagerScoreMaterializedRow[];
  sourceByEntry: ReadonlyMap<number, 'REDIS' | 'POSTGRES'>;
}>;

export type ManagerScoreMaterializationLookup = Readonly<{
  entryId: number;
  inputRevision: string;
}>;

export type ManagerScoreMaterializedRow = Readonly<{
  entryId: number;
  inputRevision: string;
  scoreRevision: string;
  generation: number;
  calculationMode: 'PROJECTED_AUTOSUBS';
  algorithmVersion: string | null;
  scoreSource: 'FPL_EVENT_LIVE';
  livePublicationId: string | null;
  liveRevision: string | null;
  liveCheckedAt: Date | null;
  picksRevision: string | null;
  picksCheckedAt: Date | null;
  previousTotalsRevision: string | null;
  previousTotalsThroughEventId: number | null;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  transferCost: number | null;
  effectiveLineup: unknown;
  rankRevision: string | null;
  rankSource: 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | null;
  rankCheckedAt: Date | null;
}>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATERIALIZATION_CACHE_TTL_SECONDS = 48 * 60 * 60;

const managerScoreHeadRedisKey = (
  season: FplSeasonRef,
  eventId: number,
  calculationMode: ManagerScoreMaterializationInput['calculationMode'],
): string => `ManagerScoreHead:${season.seasonCode}:${eventId}:${calculationMode}`;

const managerScoreMaterializationRedisKey = (
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  inputRevision: string,
): string =>
  `ManagerScoreMaterialization:${season.seasonCode}:${eventId}:${entryId}:${inputRevision}`;

const PUBLISH_MATERIALIZATION_HEADS_SCRIPT = `
local head_key = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local index = 3
local updated = 0
for _ = 1, count do
  local entry_id = ARGV[index]
  local generation = tonumber(ARGV[index + 1])
  local input_revision = ARGV[index + 2]
  local materialization_key = ARGV[index + 3]
  local payload = ARGV[index + 4]
  local current_raw = redis.call('HGET', head_key, entry_id)
  local current_generation = 0
  if current_raw then
    local decoded, current = pcall(cjson.decode, current_raw)
    if decoded and type(current) == 'table' and current.generation then
      current_generation = tonumber(current.generation) or 0
    end
  end
  if generation > current_generation then
    redis.call('SET', materialization_key, payload, 'EX', ttl)
    redis.call('HSET', head_key, entry_id, cjson.encode({
      inputRevision = input_revision,
      generation = generation
    }))
    updated = updated + 1
  end
  index = index + 5
end
if updated > 0 then redis.call('EXPIRE', head_key, ttl) end
return updated
`;

const isValidTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));

const validateInput = (input: ManagerScoreMaterializationInput): void => {
  if (!UUID_RE.test(input.livePublicationId)) throw new Error('Invalid live publication UUID');
  if (
    input.calculationMode !== 'PROJECTED_AUTOSUBS' ||
    input.algorithmVersion !== EVENT_LIVE_PROJECTION_ALGORITHM_VERSION ||
    input.scoreSource !== 'FPL_EVENT_LIVE' ||
    input.liveRevision.trim() === '' ||
    input.picksRevision.trim() === '' ||
    input.previousTotalsRevision.trim() === '' ||
    !isEffectiveLineup(input.effectiveLineup)
  ) {
    throw new Error('Invalid manager score materialization provenance');
  }
  for (const timestamp of [input.liveCheckedAt, input.picksCheckedAt]) {
    if (!isValidTimestamp(timestamp)) throw new Error('Invalid manager score source timestamp');
  }
  if (
    !Number.isSafeInteger(input.entryId) ||
    input.entryId <= 0 ||
    input.inputRevision.trim() === '' ||
    input.scoreRevision.trim() === '' ||
    input.picksRevision.trim() === '' ||
    input.previousTotalsRevision.trim() === '' ||
    !Number.isSafeInteger(input.eventPoints) ||
    !Number.isSafeInteger(input.netEventPoints) ||
    !Number.isSafeInteger(input.transferCost) ||
    input.transferCost < 0 ||
    input.netEventPoints !== input.eventPoints - input.transferCost
  ) {
    throw new Error('Invalid manager score materialization identity');
  }
};

type RedisMaterializationRow = Readonly<{
  entryId: number;
  inputRevision: string;
  scoreRevision: string;
  generation: number;
  calculationMode: ManagerScoreMaterializedRow['calculationMode'];
  algorithmVersion: string | null;
  scoreSource: 'FPL_EVENT_LIVE';
  livePublicationId: string | null;
  liveRevision: string | null;
  liveCheckedAt: string | null;
  picksRevision: string | null;
  picksCheckedAt: string | null;
  previousTotalsRevision: string | null;
  previousTotalsThroughEventId: number | null;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  transferCost: number | null;
  effectiveLineup: unknown;
  rankRevision: string | null;
  rankSource: ManagerScoreMaterializedRow['rankSource'];
  rankCheckedAt: string | null;
}>;

const toRedisMaterializationRow = (
  row: ManagerScoreMaterializedRow | (ManagerScoreMaterializationInput & { generation: number }),
): RedisMaterializationRow => ({
  entryId: row.entryId,
  inputRevision: row.inputRevision,
  scoreRevision: row.scoreRevision,
  generation: row.generation,
  calculationMode: row.calculationMode,
  algorithmVersion: row.algorithmVersion,
  scoreSource: row.scoreSource,
  livePublicationId: row.livePublicationId,
  liveRevision: row.liveRevision,
  liveCheckedAt:
    typeof row.liveCheckedAt === 'string'
      ? row.liveCheckedAt
      : (row.liveCheckedAt?.toISOString() ?? null),
  picksRevision: row.picksRevision,
  picksCheckedAt:
    typeof row.picksCheckedAt === 'string'
      ? row.picksCheckedAt
      : (row.picksCheckedAt?.toISOString() ?? null),
  previousTotalsRevision: row.previousTotalsRevision,
  previousTotalsThroughEventId: row.previousTotalsThroughEventId,
  eventPoints: row.eventPoints,
  netEventPoints: row.netEventPoints,
  totalPoints: row.totalPoints,
  transferCost: row.transferCost,
  effectiveLineup: row.effectiveLineup,
  rankRevision: row.rankRevision ?? null,
  rankSource: row.rankSource ?? null,
  rankCheckedAt:
    typeof row.rankCheckedAt === 'string'
      ? row.rankCheckedAt
      : (row.rankCheckedAt?.toISOString() ?? null),
});

const parseRedisMaterializationRow = (
  raw: string | null,
  expectedEntryId: number,
  expectedInputRevision: string,
  expectedMode: ManagerScoreMaterializedRow['calculationMode'],
): ManagerScoreMaterializedRow | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RedisMaterializationRow>;
    const generation = parsed.generation;
    if (
      parsed.entryId !== expectedEntryId ||
      parsed.inputRevision !== expectedInputRevision ||
      parsed.calculationMode !== expectedMode ||
      parsed.scoreSource !== 'FPL_EVENT_LIVE' ||
      typeof parsed.scoreRevision !== 'string' ||
      parsed.scoreRevision.trim() === '' ||
      parsed.algorithmVersion !== EVENT_LIVE_PROJECTION_ALGORITHM_VERSION ||
      typeof parsed.livePublicationId !== 'string' ||
      !UUID_RE.test(parsed.livePublicationId) ||
      typeof parsed.liveRevision !== 'string' ||
      parsed.liveRevision.trim() === '' ||
      typeof parsed.picksRevision !== 'string' ||
      parsed.picksRevision.trim() === '' ||
      typeof parsed.previousTotalsRevision !== 'string' ||
      parsed.previousTotalsRevision.trim() === '' ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    ) {
      return null;
    }
    const asDate = (value: unknown): Date | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
      return new Date(value);
    };
    const liveCheckedAt = asDate(parsed.liveCheckedAt);
    const picksCheckedAt = asDate(parsed.picksCheckedAt);
    const rankCheckedAt = asDate(parsed.rankCheckedAt);
    if (!liveCheckedAt || !picksCheckedAt) return null;
    if (parsed.rankCheckedAt !== null && parsed.rankCheckedAt !== undefined && !rankCheckedAt)
      return null;
    if (
      (parsed.eventPoints !== null &&
        parsed.eventPoints !== undefined &&
        (typeof parsed.eventPoints !== 'number' || !Number.isSafeInteger(parsed.eventPoints))) ||
      (parsed.netEventPoints !== null &&
        parsed.netEventPoints !== undefined &&
        (typeof parsed.netEventPoints !== 'number' ||
          !Number.isSafeInteger(parsed.netEventPoints))) ||
      (parsed.totalPoints !== null &&
        parsed.totalPoints !== undefined &&
        (typeof parsed.totalPoints !== 'number' || !Number.isSafeInteger(parsed.totalPoints))) ||
      typeof parsed.transferCost !== 'number' ||
      !Number.isSafeInteger(parsed.transferCost) ||
      parsed.transferCost < 0 ||
      !isEffectiveLineup(parsed.effectiveLineup) ||
      parsed.eventPoints === null ||
      parsed.eventPoints === undefined ||
      parsed.netEventPoints === null ||
      parsed.netEventPoints === undefined ||
      parsed.netEventPoints !== parsed.eventPoints - parsed.transferCost
    ) {
      return null;
    }
    const expectedScoreRevision = contentHash({
      inputRevision: parsed.inputRevision,
      eventPoints: parsed.eventPoints,
      netEventPoints: parsed.netEventPoints,
      totalPoints: parsed.totalPoints ?? null,
      effectiveLineup: parsed.effectiveLineup,
    });
    if (parsed.scoreRevision !== expectedScoreRevision) return null;
    return {
      entryId: parsed.entryId,
      inputRevision: parsed.inputRevision,
      scoreRevision: parsed.scoreRevision,
      generation,
      calculationMode: parsed.calculationMode,
      algorithmVersion: parsed.algorithmVersion,
      scoreSource: parsed.scoreSource,
      livePublicationId: parsed.livePublicationId ?? null,
      liveRevision: parsed.liveRevision ?? null,
      liveCheckedAt,
      picksRevision: parsed.picksRevision ?? null,
      picksCheckedAt,
      previousTotalsRevision: parsed.previousTotalsRevision ?? null,
      previousTotalsThroughEventId: parsed.previousTotalsThroughEventId ?? null,
      eventPoints: parsed.eventPoints,
      netEventPoints: parsed.netEventPoints,
      totalPoints: parsed.totalPoints ?? null,
      transferCost: parsed.transferCost ?? null,
      effectiveLineup: parsed.effectiveLineup,
      rankRevision: parsed.rankRevision ?? null,
      rankSource: parsed.rankSource ?? null,
      rankCheckedAt,
    };
  } catch {
    return null;
  }
};

const publishMaterializationHeadsToRedis = async (
  season: FplSeasonRef,
  eventId: number,
  rows: readonly (ManagerScoreMaterializationInput & { generation: number })[],
): Promise<void> => {
  if (rows.length === 0) return;
  const redis = await redisSingleton.getClient();
  const mode = rows[0]!.calculationMode;
  if (rows.some((row) => row.calculationMode !== mode)) {
    throw new Error('Redis materialization publication requires one calculation mode');
  }
  const args = [String(MATERIALIZATION_CACHE_TTL_SECONDS), String(rows.length)];
  for (const row of rows) {
    const normalized = toRedisMaterializationRow(row);
    args.push(
      String(row.entryId),
      String(row.generation),
      row.inputRevision,
      managerScoreMaterializationRedisKey(season, eventId, row.entryId, row.inputRevision),
      JSON.stringify(normalized),
    );
  }
  const result = await redis.eval(
    PUBLISH_MATERIALIZATION_HEADS_SCRIPT,
    1,
    managerScoreHeadRedisKey(season, eventId, mode),
    ...args,
  );
  if (!Number.isSafeInteger(Number(result))) {
    throw new Error('Redis materialization head publication returned an invalid result');
  }
};

const readMaterializationHeadsFromRedis = async (
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  calculationMode: ManagerScoreMaterializedRow['calculationMode'],
): Promise<ManagerScoreMaterializedRow[]> => {
  if (entryIds.length === 0) return [];
  const redis = await redisSingleton.getClient();
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const pointers = await redis.hmget(
    managerScoreHeadRedisKey(season, eventId, calculationMode),
    ...uniqueEntryIds.map(String),
  );
  const pointerByEntry = new Map<number, { inputRevision: string; generation: number }>();
  for (let index = 0; index < uniqueEntryIds.length; index += 1) {
    const raw = pointers[index];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { inputRevision?: unknown; generation?: unknown };
      const generation = parsed.generation;
      if (
        typeof parsed.inputRevision === 'string' &&
        parsed.inputRevision.length > 0 &&
        typeof generation === 'number' &&
        Number.isSafeInteger(generation) &&
        generation > 0
      ) {
        pointerByEntry.set(uniqueEntryIds[index]!, {
          inputRevision: parsed.inputRevision,
          generation,
        });
      }
    } catch {
      // A malformed pointer is treated as a miss and repaired from PostgreSQL.
    }
  }
  const entriesWithPointers = uniqueEntryIds.filter((entryId) => pointerByEntry.has(entryId));
  if (entriesWithPointers.length === 0) return [];
  const payloads = await redis.mget(
    ...entriesWithPointers.map((entryId) => {
      const pointer = pointerByEntry.get(entryId)!;
      return managerScoreMaterializationRedisKey(season, eventId, entryId, pointer.inputRevision);
    }),
  );
  const rows: ManagerScoreMaterializedRow[] = [];
  for (let index = 0; index < entriesWithPointers.length; index += 1) {
    const entryId = entriesWithPointers[index]!;
    const pointer = pointerByEntry.get(entryId)!;
    const row = parseRedisMaterializationRow(
      payloads[index] ?? null,
      entryId,
      pointer.inputRevision,
      calculationMode,
    );
    if (row && row.generation === pointer.generation) rows.push(row);
  }
  return rows;
};

const readMaterializationByInputFromRedis = async (
  season: FplSeasonRef,
  eventId: number,
  lookups: readonly ManagerScoreMaterializationLookup[],
  calculationMode: ManagerScoreMaterializedRow['calculationMode'],
): Promise<ManagerScoreMaterializedRow[]> => {
  if (lookups.length === 0) return [];
  const redis = await redisSingleton.getClient();
  const uniqueLookups = Array.from(
    new Map(
      lookups.map((lookup) => [`${lookup.entryId}:${lookup.inputRevision}`, lookup]),
    ).values(),
  );
  const payloads = await redis.mget(
    ...uniqueLookups.map((lookup) =>
      managerScoreMaterializationRedisKey(season, eventId, lookup.entryId, lookup.inputRevision),
    ),
  );
  return uniqueLookups.flatMap((lookup, index) => {
    const row = parseRedisMaterializationRow(
      payloads[index] ?? null,
      lookup.entryId,
      lookup.inputRevision,
      calculationMode,
    );
    return row ? [row] : [];
  });
};

/**
 * Reuse immutable materializations for the exact current input revision. A
 * materialization may be reused even when it is no longer the active head;
 * the input revision itself contains the live publication and all scoring
 * inputs, so it remains valid for an overlapping entry set.
 */
export async function readManagerScoreMaterializationsByInputRevision(
  season: FplSeasonRef,
  eventId: number,
  lookups: readonly ManagerScoreMaterializationLookup[],
  calculationMode: ManagerScoreMaterializedRow['calculationMode'],
): Promise<ManagerScoreMaterializedRow[]> {
  const uniqueLookups = Array.from(
    new Map(
      lookups.map((lookup) => [`${lookup.entryId}:${lookup.inputRevision}`, lookup]),
    ).values(),
  );
  if (uniqueLookups.length === 0) return [];

  let cachedRows: ManagerScoreMaterializedRow[] = [];
  try {
    cachedRows = await readMaterializationByInputFromRedis(
      season,
      eventId,
      uniqueLookups,
      calculationMode,
    );
  } catch (error) {
    logWarn('Manager score materialization Redis lookup failed; using PostgreSQL', {
      eventId,
      entries: uniqueLookups.length,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  const byIdentity = new Map(
    cachedRows.map((row) => [`${row.entryId}:${row.inputRevision}`, row] as const),
  );
  const missingLookups = uniqueLookups.filter(
    (lookup) => !byIdentity.has(`${lookup.entryId}:${lookup.inputRevision}`),
  );
  if (missingLookups.length > 0) {
    const db = await getDbClient();
    const entryIds = Array.from(new Set(missingLookups.map((lookup) => lookup.entryId)));
    const inputRevisions = Array.from(
      new Set(missingLookups.map((lookup) => lookup.inputRevision)),
    );
    const rows = await db<
      Array<{
        entry_id: number;
        input_revision: string;
        score_revision: string;
        generation: number | string;
        calculation_mode: ManagerScoreMaterializedRow['calculationMode'];
        algorithm_version: string | null;
        score_source: 'FPL_EVENT_LIVE';
        live_publication_id: string | null;
        live_revision: string | null;
        live_checked_at: Date | null;
        picks_revision: string | null;
        picks_checked_at: Date | null;
        previous_totals_revision: string | null;
        previous_totals_through_event_id: number | null;
        event_points: number | null;
        net_event_points: number | null;
        total_points: number | null;
        transfer_cost: number | null;
        effective_lineup: unknown;
        rank_revision: string | null;
        rank_source: ManagerScoreMaterializedRow['rankSource'];
        rank_checked_at: Date | null;
      }>
    >`
      SELECT entry_id, input_revision, score_revision, 1::bigint AS generation,
             calculation_mode, algorithm_version, score_source,
             live_publication_id, live_revision, live_checked_at,
             picks_revision, picks_checked_at, previous_totals_revision,
             previous_totals_through_event_id, event_points, net_event_points,
             total_points, transfer_cost, effective_lineup,
             rank_revision, rank_source, rank_checked_at
      FROM fpl.manager_event_score_materializations
      WHERE season_id = ${season.seasonId}
        AND event_id = ${eventId}
        AND calculation_mode = ${calculationMode}
        AND entry_id = ANY(${entryIds}::int[])
        AND input_revision = ANY(${inputRevisions}::text[])
    `;
    for (const row of rows) {
      const materialized: ManagerScoreMaterializedRow = {
        entryId: row.entry_id,
        inputRevision: row.input_revision,
        scoreRevision: row.score_revision,
        generation: Number(row.generation),
        calculationMode: row.calculation_mode,
        algorithmVersion: row.algorithm_version,
        scoreSource: row.score_source,
        livePublicationId: row.live_publication_id,
        liveRevision: row.live_revision,
        liveCheckedAt: row.live_checked_at,
        picksRevision: row.picks_revision,
        picksCheckedAt: row.picks_checked_at,
        previousTotalsRevision: row.previous_totals_revision,
        previousTotalsThroughEventId: row.previous_totals_through_event_id,
        eventPoints: row.event_points,
        netEventPoints: row.net_event_points,
        totalPoints: row.total_points,
        transferCost: row.transfer_cost,
        effectiveLineup: row.effective_lineup,
        rankRevision: row.rank_revision,
        rankSource: row.rank_source,
        rankCheckedAt: row.rank_checked_at,
      };
      byIdentity.set(`${materialized.entryId}:${materialized.inputRevision}`, materialized);
    }
  }
  return uniqueLookups.flatMap((lookup) => {
    const row = byIdentity.get(`${lookup.entryId}:${lookup.inputRevision}`);
    return row ? [row] : [];
  });
}

const materializationLockKey = (seasonId: number, eventId: number, mode: string): string =>
  `manager-score-materialization:${seasonId}:${eventId}:${mode}`;

const materializationRevisionLockKey = (
  seasonId: number,
  eventId: number,
  mode: string,
  inputRevision: string,
): string => `${materializationLockKey(seasonId, eventId, mode)}:${inputRevision}`;

/**
 * Persist a batch after calculation. Materializations are immutable; heads
 * are advanced only while the durable fpl:live pointer still names the exact
 * publication/revision that produced the batch.
 */
export async function persistManagerScoreMaterializations(
  season: FplSeasonRef,
  eventId: number,
  rows: readonly ManagerScoreMaterializationInput[],
): Promise<ManagerScoreMaterializationResult> {
  if (rows.length === 0) {
    return { materializationsWritten: 0, headsUpdated: 0, headsRejected: 0 };
  }
  for (const row of rows) validateInput(row);
  const first = rows[0]!;
  if (rows.some((row) => row.calculationMode !== first.calculationMode)) {
    throw new Error('A materialization batch must use one calculation mode');
  }

  const db = await getDbClient();
  const rowsForRedis: Array<ManagerScoreMaterializationInput & { generation: number }> = [];
  const result = await db.begin(async (tx) => {
    // Lock each input revision in deterministic order. This coalesces the
    // common overlap between entry sets without serializing unrelated
    // revisions for the same event, while the per-entry head row lock below
    // still protects generation assignment.
    const revisions = Array.from(new Set(rows.map((row) => row.inputRevision))).sort();
    for (const revision of revisions) {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${materializationRevisionLockKey(season.seasonId, eventId, first.calculationMode, revision)}, 0)
        )
      `;
    }

    let materializationsWritten = 0;
    for (const row of rows) {
      const sourceMin = new Date(
        Math.min(Date.parse(row.liveCheckedAt), Date.parse(row.picksCheckedAt)),
      ).toISOString();
      const sourceMax = new Date(
        Math.max(Date.parse(row.liveCheckedAt), Date.parse(row.picksCheckedAt)),
      ).toISOString();
      const inserted = await tx<Array<{ inserted: boolean }>>`
        INSERT INTO fpl.manager_event_score_materializations (
          season_id, event_id, entry_id, input_revision, score_revision,
          calculation_mode, algorithm_version, score_source,
          live_publication_id, live_revision, live_checked_at,
          picks_revision, picks_checked_at, previous_totals_revision,
          previous_totals_through_event_id, event_points, net_event_points,
          total_points, transfer_cost, effective_lineup, result_revision,
          result_checked_at, data_checked_at, rank_revision, rank_source,
          rank_checked_at,
          source_min_checked_at, source_max_checked_at
        ) VALUES (
          ${season.seasonId}, ${eventId}, ${row.entryId}, ${row.inputRevision}, ${row.scoreRevision},
          ${row.calculationMode}, ${row.algorithmVersion}, ${row.scoreSource},
          ${row.livePublicationId}::uuid, ${row.liveRevision}, ${row.liveCheckedAt}::timestamptz,
          ${row.picksRevision}, ${row.picksCheckedAt}::timestamptz, ${row.previousTotalsRevision},
          ${row.previousTotalsThroughEventId}, ${row.eventPoints}, ${row.netEventPoints},
          ${row.totalPoints}, ${row.transferCost}, ${row.effectiveLineup ? JSON.stringify(row.effectiveLineup) : null}::jsonb,
          ${row.resultRevision ?? null}, ${row.resultCheckedAt ?? null}::timestamptz, ${row.dataCheckedAt ?? null}::timestamptz,
          ${row.rankRevision ?? null}, ${row.rankSource ?? null}, ${row.rankCheckedAt ?? null}::timestamptz,
          ${sourceMin}::timestamptz, ${sourceMax}::timestamptz
        )
        ON CONFLICT (season_id, event_id, entry_id, input_revision) DO NOTHING
        RETURNING true AS inserted
      `;
      if (inserted.length > 0) materializationsWritten += 1;
    }

    const pointerRows = await readActiveLivePointer(tx, season.seasonId, eventId);
    if (
      !pointerRows ||
      pointerRows.publicationId !== first.livePublicationId ||
      String(pointerRows.revision) !== first.liveRevision
    ) {
      return {
        materializationsWritten,
        headsUpdated: 0,
        headsRejected: rows.length,
      };
    }

    let headsUpdated = 0;
    let headsRejected = 0;
    for (const row of rows) {
      // Re-read the durable pointer before every CAS. A late source publisher
      // may have advanced it while the batch was being inserted.
      const currentPointer = await readActiveLivePointer(tx, season.seasonId, eventId);
      if (
        !currentPointer ||
        currentPointer.publicationId !== row.livePublicationId ||
        String(currentPointer.revision) !== row.liveRevision
      ) {
        headsRejected += 1;
        continue;
      }
      const currentInputs = await readCurrentInputRevisions(
        tx,
        season.seasonId,
        eventId,
        row.entryId,
      );
      if (
        currentInputs.picksRevision !== row.picksRevision ||
        currentInputs.previousTotalsRevision !== row.previousTotalsRevision
      ) {
        headsRejected += 1;
        continue;
      }
      const existing = await tx<
        {
          generation: number | string;
          input_revision: string;
          score_revision: string;
          verified_live_revision: string | null;
          verified_picks_revision: string | null;
          verified_previous_totals_revision: string | null;
        }[]
      >`
        SELECT generation, input_revision, score_revision,
               verified_live_revision, verified_picks_revision,
               verified_previous_totals_revision
        FROM fpl.manager_event_score_heads
        WHERE season_id = ${season.seasonId}
          AND event_id = ${eventId}
          AND entry_id = ${row.entryId}
          AND calculation_mode = ${row.calculationMode}
        FOR UPDATE
      `;
      const currentHead = existing[0];
      if (
        currentHead &&
        currentHead.input_revision === row.inputRevision &&
        currentHead.score_revision === row.scoreRevision &&
        currentHead.verified_live_revision === row.liveRevision &&
        currentHead.verified_picks_revision === row.picksRevision &&
        currentHead.verified_previous_totals_revision === row.previousTotalsRevision
      ) {
        continue;
      }
      const generation = Number(existing[0]?.generation ?? 0) + 1;
      await tx`
        INSERT INTO fpl.manager_event_score_heads (
          season_id, event_id, entry_id, calculation_mode,
          input_revision, score_revision, generation,
          verified_live_revision, verified_picks_revision,
          verified_previous_totals_revision, updated_at
        ) VALUES (
          ${season.seasonId}, ${eventId}, ${row.entryId}, ${row.calculationMode},
          ${row.inputRevision}, ${row.scoreRevision}, ${generation},
          ${row.liveRevision}, ${row.picksRevision}, ${row.previousTotalsRevision}, now()
        )
        ON CONFLICT (season_id, event_id, entry_id, calculation_mode) DO UPDATE
        SET input_revision = EXCLUDED.input_revision,
            score_revision = EXCLUDED.score_revision,
            generation = EXCLUDED.generation,
            verified_live_revision = EXCLUDED.verified_live_revision,
            verified_picks_revision = EXCLUDED.verified_picks_revision,
            verified_previous_totals_revision = EXCLUDED.verified_previous_totals_revision,
            updated_at = now()
        WHERE fpl.manager_event_score_heads.generation < EXCLUDED.generation
      `;
      rowsForRedis.push({ ...row, generation });
      headsUpdated += 1;
    }
    return { materializationsWritten, headsUpdated, headsRejected };
  });
  try {
    await publishMaterializationHeadsToRedis(season, eventId, rowsForRedis);
  } catch (error) {
    // PostgreSQL heads remain authoritative. A Redis outage only turns the
    // next CACHE_ONLY read into a PostgreSQL miss; it must not roll back a
    // committed immutable materialization.
    logWarn('Manager score materialization Redis publication failed', {
      eventId,
      entries: rowsForRedis.length,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  return result;
}

async function readCurrentInputRevisions(
  tx: postgres.TransactionSql,
  seasonId: number,
  eventId: number,
  entryId: number,
): Promise<{ picksRevision: string; previousTotalsRevision: string }> {
  const picks = await tx<
    Array<{
      position: number;
      element_id: number;
      element_type: number;
      team_id: number;
      multiplier: number;
      is_captain: boolean;
      is_vice_captain: boolean;
      transfers_cost: number | null;
      active_chip: string | null;
    }>
  >`
    SELECT pick.position, pick.element_id, player.element_type, player.team_id,
           pick.multiplier, pick.is_captain, pick.is_vice_captain,
           pick.transfers_cost, pick.active_chip::text
    FROM competition.entry_event_picks pick
    JOIN fpl.players player
      ON player.season_id = pick.season_id
     AND player.element_id = pick.element_id
    WHERE pick.season_id = ${seasonId} AND pick.event_id = ${eventId} AND pick.entry_id = ${entryId}
    ORDER BY pick.position
  `;
  const picksRevision = contentHash(
    picks.map((pick) => ({
      position: pick.position,
      elementId: pick.element_id,
      elementType: pick.element_type,
      teamId: pick.team_id,
      multiplier: pick.multiplier,
      isCaptain: pick.is_captain,
      isViceCaptain: pick.is_vice_captain,
      transfersCost: pick.transfers_cost,
      activeChip: pick.active_chip ?? null,
    })),
  );

  const results = await tx<
    Array<{
      event_id: number;
      source_result_id: number | null;
      event_net_points: number | null;
    }>
  >`
    SELECT result.event_id, result.source_result_id, result.event_net_points
    FROM competition.entry_event_results result
    JOIN competition.entries entry
      ON entry.season_id = result.season_id
     AND entry.entry_id = result.entry_id
    JOIN fpl.events event
      ON event.season_id = result.season_id
     AND event.event_id = result.event_id
    WHERE result.season_id = ${seasonId}
      AND result.entry_id = ${entryId}
      AND result.event_id BETWEEN 1 AND ${Math.max(0, eventId - 1)}
      AND result.event_id >= GREATEST(1, COALESCE(entry.started_event, 1))
      AND result.rich_synced_at IS NOT NULL
      AND event.finished = true
      AND event.data_checked = true
    ORDER BY result.event_id
  `;
  const previousTotal = results.reduce((sum, result) => sum + (result.event_net_points ?? 0), 0);
  const previousTotalsRevision = contentHash({
    throughEventId: eventId > 1 ? eventId - 1 : null,
    totalNetPoints: eventId > 1 ? previousTotal : 0,
    results: results
      .map((result) => ({
        entryId,
        eventId: result.event_id,
        sourceResultId: result.source_result_id,
        eventNetPoints: result.event_net_points,
      }))
      .sort((left, right) => left.eventId - right.eventId || left.entryId - right.entryId),
  });
  return { picksRevision, previousTotalsRevision };
}

/**
 * Read only the currently CAS-verified materialization heads. This is the
 * projected CACHE_ONLY path: it may serve durable score materializations, but
 * it never calls the projector or an upstream FPL client on a cache miss.
 */
async function readManagerScoreHeadRowsFromPostgres(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  calculationMode: 'PROJECTED_AUTOSUBS',
): Promise<ManagerScoreMaterializedRow[]> {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) return [];
  const db = await getDbClient();
  const rows = await db<
    Array<{
      entry_id: number;
      input_revision: string;
      score_revision: string;
      generation: number | string;
      calculation_mode: ManagerScoreMaterializedRow['calculationMode'];
      algorithm_version: string | null;
      score_source: 'FPL_EVENT_LIVE';
      live_publication_id: string | null;
      live_revision: string | null;
      live_checked_at: Date | null;
      picks_revision: string | null;
      picks_checked_at: Date | null;
      previous_totals_revision: string | null;
      previous_totals_through_event_id: number | null;
      event_points: number | null;
      net_event_points: number | null;
      total_points: number | null;
      transfer_cost: number | null;
      effective_lineup: unknown;
      rank_revision: string | null;
      rank_source: ManagerScoreMaterializedRow['rankSource'];
      rank_checked_at: Date | null;
    }>
  >`
    SELECT
      head.entry_id,
      head.input_revision,
      head.score_revision,
      head.generation,
      materialization.calculation_mode,
      materialization.algorithm_version,
      materialization.score_source,
      materialization.live_publication_id,
      materialization.live_revision,
      materialization.live_checked_at,
      materialization.picks_revision,
      materialization.picks_checked_at,
      materialization.previous_totals_revision,
      materialization.previous_totals_through_event_id,
      materialization.event_points,
      materialization.net_event_points,
      materialization.total_points,
      materialization.transfer_cost,
      materialization.effective_lineup,
      materialization.rank_revision,
      materialization.rank_source,
      materialization.rank_checked_at
    FROM fpl.manager_event_score_heads head
    JOIN fpl.manager_event_score_materializations materialization
      ON materialization.season_id = head.season_id
     AND materialization.event_id = head.event_id
     AND materialization.entry_id = head.entry_id
     AND materialization.input_revision = head.input_revision
    WHERE head.season_id = ${season.seasonId}
      AND head.event_id = ${eventId}
      AND head.calculation_mode = ${calculationMode}
      AND head.entry_id = ANY(${uniqueEntryIds}::int[])
    ORDER BY head.entry_id
  `;
  return rows.map((row) => ({
    entryId: row.entry_id,
    inputRevision: row.input_revision,
    scoreRevision: row.score_revision,
    generation: Number(row.generation),
    calculationMode: row.calculation_mode,
    algorithmVersion: row.algorithm_version,
    scoreSource: row.score_source,
    livePublicationId: row.live_publication_id,
    liveRevision: row.live_revision,
    liveCheckedAt: row.live_checked_at,
    picksRevision: row.picks_revision,
    picksCheckedAt: row.picks_checked_at,
    previousTotalsRevision: row.previous_totals_revision,
    previousTotalsThroughEventId: row.previous_totals_through_event_id,
    eventPoints: row.event_points,
    netEventPoints: row.net_event_points,
    totalPoints: row.total_points,
    transferCost: row.transfer_cost,
    effectiveLineup: row.effective_lineup,
    rankRevision: row.rank_revision,
    rankSource: row.rank_source,
    rankCheckedAt: row.rank_checked_at,
  }));
}

/**
 * Resolve heads from the 48-hour Redis cache first, then repair misses from
 * PostgreSQL. A Redis head is accepted only when its generation and immutable
 * materialization payload agree; a late publisher can therefore never replace
 * a newer head with an older score.
 */
export async function readManagerScoreHeadRowsWithSource(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  calculationMode: 'PROJECTED_AUTOSUBS',
): Promise<ManagerScoreHeadReadResult> {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) {
    return { rows: [], sourceByEntry: new Map() };
  }

  let cachedRows: ManagerScoreMaterializedRow[] = [];
  try {
    cachedRows = await readMaterializationHeadsFromRedis(
      season,
      eventId,
      uniqueEntryIds,
      calculationMode,
    );
  } catch (error) {
    logWarn('Manager score materialization Redis read failed; using PostgreSQL heads', {
      eventId,
      entries: uniqueEntryIds.length,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  const cachedByEntry = new Map(cachedRows.map((row) => [row.entryId, row] as const));
  const sourceByEntry = new Map<number, 'REDIS' | 'POSTGRES'>(
    cachedRows.map((row) => [row.entryId, 'REDIS'] as const),
  );
  const missingEntryIds = uniqueEntryIds.filter((entryId) => !cachedByEntry.has(entryId));
  if (missingEntryIds.length > 0) {
    try {
      const databaseRows = await readManagerScoreHeadRowsFromPostgres(
        season,
        eventId,
        missingEntryIds,
        calculationMode,
      );
      for (const row of databaseRows) {
        cachedByEntry.set(row.entryId, row);
        sourceByEntry.set(row.entryId, 'POSTGRES');
      }
      if (databaseRows.length > 0) {
        try {
          const redisRows = databaseRows.flatMap((row) => {
            if (
              row.livePublicationId === null ||
              row.liveRevision === null ||
              row.liveCheckedAt === null ||
              row.picksRevision === null ||
              row.picksCheckedAt === null ||
              row.previousTotalsRevision === null ||
              row.eventPoints === null ||
              row.netEventPoints === null ||
              row.transferCost === null
            ) {
              return [];
            }
            return [
              {
                entryId: row.entryId,
                inputRevision: row.inputRevision,
                scoreRevision: row.scoreRevision,
                generation: row.generation,
                calculationMode: row.calculationMode,
                algorithmVersion: row.algorithmVersion,
                scoreSource: row.scoreSource,
                livePublicationId: row.livePublicationId,
                liveRevision: row.liveRevision,
                liveCheckedAt: row.liveCheckedAt.toISOString(),
                picksRevision: row.picksRevision,
                picksCheckedAt: row.picksCheckedAt.toISOString(),
                previousTotalsRevision: row.previousTotalsRevision,
                previousTotalsThroughEventId: row.previousTotalsThroughEventId,
                eventPoints: row.eventPoints,
                netEventPoints: row.netEventPoints,
                totalPoints: row.totalPoints,
                transferCost: row.transferCost,
                effectiveLineup: Array.isArray(row.effectiveLineup)
                  ? (row.effectiveLineup as readonly EffectiveLineupRow[])
                  : null,
                rankRevision: row.rankRevision,
                rankSource: row.rankSource,
                rankCheckedAt: row.rankCheckedAt?.toISOString() ?? null,
              } as ManagerScoreMaterializationInput & { generation: number },
            ];
          });
          await publishMaterializationHeadsToRedis(season, eventId, redisRows);
        } catch (error) {
          logWarn('Manager score materialization cache repair failed', {
            eventId,
            entries: databaseRows.length,
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }
    } catch (error) {
      logWarn('Manager score materialization PostgreSQL read failed', {
        eventId,
        entries: missingEntryIds.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return {
    rows: uniqueEntryIds.flatMap((entryId) => {
      const row = cachedByEntry.get(entryId);
      return row ? [row] : [];
    }),
    sourceByEntry,
  };
}

/** Rows-only convenience helper for callers that do not need cache backing. */
export async function readManagerScoreHeadRows(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  calculationMode: 'PROJECTED_AUTOSUBS',
): Promise<ManagerScoreMaterializedRow[]> {
  return (await readManagerScoreHeadRowsWithSource(season, eventId, entryIds, calculationMode))
    .rows;
}

async function readActiveLivePointer(
  tx: postgres.TransactionSql,
  seasonId: number,
  eventId: number,
): Promise<{ publicationId: string; revision: number | string } | null> {
  const rows = await tx<{ publication_id: string; revision: number | string }[]>`
    SELECT publication_id, revision
    FROM ops.dataset_publications
    WHERE dataset = 'fpl:live'
      AND season_id = ${seasonId}
      AND event_id = ${eventId}
      AND status = 'active'
    ORDER BY revision DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { publicationId: row.publication_id, revision: row.revision } : null;
}
