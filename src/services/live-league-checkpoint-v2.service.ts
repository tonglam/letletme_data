import { and, asc, desc, eq, sql } from 'drizzle-orm';

import {
  liveLeagueCheckpointsInCompetition,
  tournamentsInCompetition,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  clearLiveLeagueCheckpointDesiredV2,
  listLiveLeagueCheckpointDesiredScopesV2,
  markLiveLeaguePublicationCheckpointedV2,
  parseLiveLeaguePublicationV2Manifest,
  readLiveLeagueCheckpointDesiredV2,
  readLiveLeaguePublicationV2,
  validateLiveLeaguePublicationV2Checkpoint,
  type LeagueLiveScope,
  type LeagueLiveRead,
} from '../cache/live-league-publication-v2';
import { redisSingleton } from '../cache/singleton';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { logError } from '../utils/logger';
import { mapWithConcurrency } from '../utils/async';
import type { FplSeasonRef } from '../domain/fpl-season';

const CHECKPOINT_INTERVAL_MS = 10 * 60_000;

function seasonIdFromCode(season: string): number {
  if (!/^\d{4}$/.test(season)) throw new Error('Invalid live league season code');
  return 2000 + Number(season.slice(0, 2));
}

export function isLiveLeagueCheckpointGenerationCompatible(
  current: { readonly generation: number; readonly publicationId: string } | null | undefined,
  candidate: { readonly generation: number; readonly publicationId: string },
): boolean {
  if (!current) return true;
  if (current.generation > candidate.generation) return false;
  return (
    current.generation !== candidate.generation || current.publicationId === candidate.publicationId
  );
}

function shouldCheckpoint(
  candidate: LeagueLiveRead,
  force: boolean,
  notBefore: string | null = null,
): boolean {
  if (force || candidate.publication.state === 'FINALIZED') return true;
  if (notBefore !== null) {
    const earliest = Date.parse(notBefore);
    if (Number.isFinite(earliest) && Date.now() < earliest) return false;
  }
  const checkpointedAt = candidate.publication.times.checkpointedAt;
  if (!checkpointedAt) return true;
  const time = Date.parse(checkpointedAt);
  return !Number.isFinite(time) || Date.now() - time >= CHECKPOINT_INTERVAL_MS;
}

/**
 * Returns the durable generation floor for one exact Redis publication scope.
 * This is used only on a cold Redis allocation path; warm publication reads do
 * not add a PostgreSQL round trip.
 */
export async function readLiveLeagueCheckpointGenerationV2(
  scope: LeagueLiveScope,
): Promise<number> {
  if (scope.scope === 'H2H_MATCH') return 0;
  const db = await getDb();
  const seasonId = seasonIdFromCode(scope.season);
  const rows = await db
    .select({ generation: liveLeagueCheckpointsInCompetition.generation })
    .from(liveLeagueCheckpointsInCompetition)
    .where(
      and(
        eq(liveLeagueCheckpointsInCompetition.seasonId, seasonId),
        eq(liveLeagueCheckpointsInCompetition.eventId, scope.eventId),
        eq(liveLeagueCheckpointsInCompetition.tournamentId, scope.tournamentId),
        eq(liveLeagueCheckpointsInCompetition.scopeKind, scope.scope),
      ),
    )
    .orderBy(desc(liveLeagueCheckpointsInCompetition.generation))
    .limit(1);
  const generation = Number(rows[0]?.generation ?? 0);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

/** Read and validate one exact persisted FINAL league publication. */
export async function readLiveLeagueCheckpointV2(
  scope: LeagueLiveScope,
  dbInstance?: DbOrTransaction,
): Promise<LeagueLiveRead | null> {
  if (scope.scope === 'H2H_MATCH') return null;
  const db = dbInstance ?? (await getDb());
  const seasonId = seasonIdFromCode(scope.season);
  const [row] = await db
    .select()
    .from(liveLeagueCheckpointsInCompetition)
    .where(
      and(
        eq(liveLeagueCheckpointsInCompetition.seasonId, seasonId),
        eq(liveLeagueCheckpointsInCompetition.eventId, scope.eventId),
        eq(liveLeagueCheckpointsInCompetition.tournamentId, scope.tournamentId),
        eq(liveLeagueCheckpointsInCompetition.scopeKind, scope.scope),
        eq(liveLeagueCheckpointsInCompetition.state, 'FINALIZED'),
      ),
    )
    .orderBy(desc(liveLeagueCheckpointsInCompetition.generation))
    .limit(1);
  if (!row) return null;
  const publication = parseLiveLeaguePublicationV2Manifest(JSON.stringify(row.manifest), scope);
  if (
    !publication ||
    publication.state !== 'FINALIZED' ||
    publication.times.checkpointedAt === null ||
    !validateLiveLeaguePublicationV2Checkpoint(scope, row.manifest, row.indexPayload, row.payload, {
      publicationId: row.publicationId,
      generation: row.generation,
      state: row.state,
      rowCount: row.rowCount,
      payloadBytes: row.payloadBytes,
      payloadSha256: row.payloadSha256,
    }) ||
    !Array.isArray(row.indexPayload) ||
    row.payload === null ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  ) {
    return null;
  }
  return {
    publication,
    index: row.indexPayload as LeagueLiveRead['index'],
    payload: row.payload as LeagueLiveRead['payload'],
    servedFrom: 'POSTGRES_CHECKPOINT',
  };
}

type H2HFinalizationPhase = Readonly<{
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
}>;

type LiveLeagueFinalizationTournament = H2HFinalizationPhase &
  Readonly<{
    tournamentId: number;
    leagueType: string;
    rosterMode: string;
    groupMode: string | null;
  }>;

export function isH2HTournamentPhaseActive(
  tournament: H2HFinalizationPhase,
  eventId: number,
): boolean {
  const phases = [
    [tournament.groupStartedEventId, tournament.groupEndedEventId],
    [tournament.knockoutStartedEventId, tournament.knockoutEndedEventId],
  ] as const;
  if (!phases.some(([start, end]) => start !== null || end !== null)) return true;
  return phases.some(
    ([start, end]) =>
      (start !== null && eventId >= start && (end === null || eventId <= end)) ||
      (start === null && end !== null && eventId <= end),
  );
}

export function requiredLiveLeagueFinalCheckpointScopesV2(
  season: string,
  eventId: number,
  tournaments: readonly LiveLeagueFinalizationTournament[],
): readonly LeagueLiveScope[] {
  return tournaments.flatMap((tournament): readonly LeagueLiveScope[] => {
    if (tournament.leagueType === 'classic') {
      return [{ season, eventId, tournamentId: tournament.tournamentId, scope: 'CLASSIC' }];
    }
    if (
      tournament.leagueType !== 'h2h' ||
      tournament.rosterMode !== 'official_sync' ||
      tournament.groupMode !== 'battle_races' ||
      !isH2HTournamentPhaseActive(tournament, eventId)
    ) {
      return [];
    }
    return [
      { season, eventId, tournamentId: tournament.tournamentId, scope: 'H2H_HEAD' },
      { season, eventId, tournamentId: tournament.tournamentId, scope: 'H2H_STANDINGS' },
    ];
  });
}

/** List every FINAL checkpoint scope required by the canonical active tournaments. */
export async function listRequiredLiveLeagueFinalCheckpointScopesV2(
  season: FplSeasonRef,
  eventId: number,
  dbInstance?: DbOrTransaction,
): Promise<readonly LeagueLiveScope[]> {
  const db = dbInstance ?? (await getDb());
  const rows = await db
    .select({
      tournamentId: tournamentsInCompetition.tournamentId,
      leagueType: tournamentsInCompetition.leagueType,
      rosterMode: tournamentsInCompetition.rosterMode,
      groupMode: tournamentsInCompetition.groupMode,
      groupStartedEventId: tournamentsInCompetition.groupStartedEventId,
      groupEndedEventId: tournamentsInCompetition.groupEndedEventId,
      knockoutStartedEventId: tournamentsInCompetition.knockoutStartedEventId,
      knockoutEndedEventId: tournamentsInCompetition.knockoutEndedEventId,
    })
    .from(tournamentsInCompetition)
    .where(
      and(
        eq(tournamentsInCompetition.seasonId, season.seasonId),
        eq(tournamentsInCompetition.state, 'active'),
        eq(tournamentsInCompetition.setupStatus, 'ready'),
      ),
    )
    .orderBy(asc(tournamentsInCompetition.tournamentId));
  return requiredLiveLeagueFinalCheckpointScopesV2(season.seasonCode, eventId, rows);
}

function checkpointValues(read: LeagueLiveRead, checkpointedAt: Date) {
  const manifest = {
    ...read.publication,
    times: {
      ...read.publication.times,
      checkpointedAt: checkpointedAt.toISOString(),
    },
  };
  const indexPayload = [...read.index];
  const payload = read.payload;
  const packed = { index: indexPayload, payload };
  return {
    manifest,
    indexPayload,
    payload,
    rowCount: indexPayload.length,
    payloadBytes: Buffer.byteLength(canonicalJson(packed), 'utf8'),
    payloadSha256: contentHash(packed),
    sourceCheckedAt: new Date(read.publication.times.sourceCheckedAt),
    contentUpdatedAt: new Date(read.publication.times.contentUpdatedAt),
    publishedAt: new Date(read.publication.times.publishedAt),
    checkpointedAt,
    expectedNextCheckAt:
      read.publication.times.expectedNextCheckAt === null
        ? null
        : new Date(read.publication.times.expectedNextCheckAt),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameFinalizedPublicationContent(
  read: LeagueLiveRead,
  persisted: {
    readonly state: string;
    readonly manifest: unknown;
    readonly rowCount: number;
  },
): boolean {
  // A Redis rebuild may allocate a fresh publication identity. FINALIZED is
  // still immutable: a newer identity may advance the durable pointer only
  // when it carries the same scope, global vector, revision vector, counts,
  // and semantic content identity. A structurally valid but semantically
  // different publication is a new result and must not replace history here.
  if (persisted.state !== 'FINALIZED' || persisted.rowCount !== read.index.length) return false;
  if (!isRecord(persisted.manifest)) return false;
  const stable = (manifest: Record<string, unknown>) => ({
    contractVersion: manifest.contractVersion,
    season: manifest.season,
    eventId: manifest.eventId,
    tournamentId: manifest.tournamentId,
    scope: manifest.scope,
    matchId: manifest.matchId,
    state: manifest.state,
    globalRef: manifest.globalRef,
    revisions: manifest.revisions,
    counts: manifest.counts,
  });
  return canonicalJson(stable(persisted.manifest)) === canonicalJson(stable(read.publication));
}

/**
 * Allow a validated Classic FINAL publication to advance a durable FINAL
 * checkpoint only when it is an append-only roster successor. A roster can
 * grow after a checkpoint is written when a late tournament entry is created;
 * retaining the old checkpoint forever would make the retention obligation
 * impossible to satisfy even though the new publication is complete. Existing
 * rows and their payloads must remain canonically equivalent by entry ID;
 * ordering may change when the canonical roster query inserts a lower ID. The
 * caller validates the candidate as a complete FINAL publication before this
 * predicate is considered, so additions are the only permitted change.
 */
export function isSafeFinalizedClassicRosterExpansion(
  read: LeagueLiveRead,
  persisted: {
    readonly state: string;
    readonly manifest: unknown;
    readonly rowCount: number;
    readonly indexPayload: unknown;
    readonly payload: unknown;
  },
): boolean {
  try {
    if (
      read.publication.scope !== 'CLASSIC' ||
      read.publication.state !== 'FINALIZED' ||
      persisted.state !== 'FINALIZED' ||
      !isRecord(persisted.manifest) ||
      !Array.isArray(persisted.indexPayload) ||
      !isRecord(persisted.payload) ||
      !Number.isSafeInteger(persisted.rowCount) ||
      persisted.rowCount < 0 ||
      persisted.rowCount !== persisted.indexPayload.length ||
      read.index.length <= persisted.indexPayload.length
    ) {
      return false;
    }

    const persistedIndex = persisted.indexPayload;
    const candidateIndex = read.index;
    const persistedManifest = persisted.manifest;
    if (
      persistedManifest.state !== 'FINALIZED' ||
      persistedManifest.contractVersion !== read.publication.contractVersion ||
      persistedManifest.season !== read.publication.season ||
      persistedManifest.eventId !== read.publication.eventId ||
      persistedManifest.tournamentId !== read.publication.tournamentId ||
      persistedManifest.scope !== 'CLASSIC' ||
      !isRecord(persistedManifest.counts) ||
      persistedManifest.counts.expected !== persistedIndex.length ||
      canonicalJson(persistedManifest.globalRef) !== canonicalJson(read.publication.globalRef)
    ) {
      return false;
    }

    if (
      !isRecord(read.publication.counts) ||
      read.publication.counts.expected !== candidateIndex.length ||
      Object.keys(persisted.payload).length !== persistedIndex.length ||
      Object.keys(read.payload).length !== candidateIndex.length
    ) {
      return false;
    }
    const candidateRowsById = new Map<number, unknown>();
    const rankShiftIsValid = (previous: unknown, candidate: unknown): boolean => {
      if (previous === candidate) return true;
      return (
        typeof previous === 'number' &&
        Number.isSafeInteger(previous) &&
        previous > 0 &&
        typeof candidate === 'number' &&
        Number.isSafeInteger(candidate) &&
        candidate > 0
      );
    };
    const comparableIndexRow = (value: unknown): unknown => {
      if (!isRecord(value)) return value;
      const { overallRank: _overallRank, lastOverallRank: _lastOverallRank, ...stable } = value;
      return stable;
    };
    const entryId = (value: unknown): number | null => {
      if (
        !isRecord(value) ||
        typeof value.entryId !== 'number' ||
        !Number.isSafeInteger(value.entryId) ||
        value.entryId <= 0
      ) {
        return null;
      }
      return value.entryId;
    };

    for (const row of candidateIndex) {
      const id = entryId(row);
      if (id === null || candidateRowsById.has(id)) return false;
      candidateRowsById.set(id, row);
    }

    const persistedIds = new Set<number>();
    for (const row of persistedIndex) {
      const id = entryId(row);
      if (id === null) return false;
      if (persistedIds.has(id)) return false;
      persistedIds.add(id);
      const candidateRow = candidateRowsById.get(id);
      if (candidateRow === undefined) return false;
      // Overall ranks are cohort-derived: adding a valid roster entry can
      // change the rank and the previous-rank snapshot for every existing
      // entry even when that entry's identity, input and score are unchanged.
      // Keep every other index field strict so a successor cannot hide a
      // mutation behind the roster-expansion exception.
      if (
        !isRecord(row) ||
        !isRecord(candidateRow) ||
        !rankShiftIsValid(row.overallRank, candidateRow.overallRank) ||
        !rankShiftIsValid(row.lastOverallRank, candidateRow.lastOverallRank)
      ) {
        return false;
      }
      if (
        canonicalJson(comparableIndexRow(row)) !== canonicalJson(comparableIndexRow(candidateRow))
      ) {
        return false;
      }
      const key = String(id);
      if (
        !Object.prototype.hasOwnProperty.call(persisted.payload, key) ||
        !Object.prototype.hasOwnProperty.call(read.payload, key) ||
        canonicalJson(persisted.payload[key]) !== canonicalJson(read.payload[key])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function storedFinalizedCheckpointIsValid(
  scope: LeagueLiveScope,
  current: {
    readonly publicationId: string;
    readonly generation: number;
    readonly state: string;
    readonly manifest: unknown;
    readonly indexPayload: unknown;
    readonly payload: unknown;
    readonly rowCount: number;
    readonly payloadBytes: number;
    readonly payloadSha256: string;
  },
): boolean {
  return validateLiveLeaguePublicationV2Checkpoint(
    scope,
    current.manifest,
    current.indexPayload,
    current.payload,
    {
      publicationId: current.publicationId,
      generation: current.generation,
      state: current.state,
      rowCount: current.rowCount,
      payloadBytes: current.payloadBytes,
      payloadSha256: current.payloadSha256,
    },
  );
}

/** Persist one self-contained latest publication without blocking its Redis promotion. */
export type LiveLeagueCheckpointOptions = Readonly<{
  /** Observe database failures so callers can preserve retryable classification. */
  onInfrastructureFailure?: (error: unknown) => void;
}>;

export async function checkpointLiveLeaguePublicationV2(
  read: LeagueLiveRead,
  dbInstance?: DbOrTransaction,
  options: LiveLeagueCheckpointOptions = {},
): Promise<boolean> {
  if (read.publication.scope === 'H2H_MATCH') return false;
  const db = dbInstance ?? (await getDb());
  const values = checkpointValues(read, new Date());
  const scope = {
    season: read.publication.season,
    eventId: read.publication.eventId,
    tournamentId: read.publication.tournamentId,
    scope: read.publication.scope,
  } as const;
  const candidateIsValidFinalized =
    read.publication.state === 'FINALIZED' &&
    validateLiveLeaguePublicationV2Checkpoint(
      scope,
      values.manifest,
      values.indexPayload,
      values.payload,
      {
        publicationId: read.publication.publicationId,
        generation: read.publication.generation,
        state: read.publication.state,
        rowCount: values.rowCount,
        payloadBytes: values.payloadBytes,
        payloadSha256: values.payloadSha256,
      },
    );
  if (read.publication.state === 'FINALIZED' && !candidateIsValidFinalized) return false;
  try {
    return await db.transaction(async (tx) => {
      // Lock contention must fail fast, while a validated multi-megabyte league
      // publication gets a separate bounded budget for JSONB persistence.
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '20s'`);
      const seasonId = seasonIdFromCode(read.publication.season);
      const existing = await tx
        .select({
          publicationId: liveLeagueCheckpointsInCompetition.publicationId,
          generation: liveLeagueCheckpointsInCompetition.generation,
          state: liveLeagueCheckpointsInCompetition.state,
          manifest: liveLeagueCheckpointsInCompetition.manifest,
          rowCount: liveLeagueCheckpointsInCompetition.rowCount,
          indexPayload: liveLeagueCheckpointsInCompetition.indexPayload,
          payload: liveLeagueCheckpointsInCompetition.payload,
          payloadBytes: liveLeagueCheckpointsInCompetition.payloadBytes,
          payloadSha256: liveLeagueCheckpointsInCompetition.payloadSha256,
        })
        .from(liveLeagueCheckpointsInCompetition)
        .where(
          and(
            eq(liveLeagueCheckpointsInCompetition.seasonId, seasonId),
            eq(liveLeagueCheckpointsInCompetition.eventId, read.publication.eventId),
            eq(liveLeagueCheckpointsInCompetition.tournamentId, read.publication.tournamentId),
            eq(liveLeagueCheckpointsInCompetition.scopeKind, read.publication.scope),
          ),
        )
        .orderBy(desc(liveLeagueCheckpointsInCompetition.generation))
        .limit(1)
        .for('update');
      const current = existing[0];
      let currentIsInvalidFinalized = false;
      let allowFinalizedRosterExpansion = false;
      if (current && current.state === 'FINALIZED') {
        const currentIsValidFinalized = storedFinalizedCheckpointIsValid(scope, current);
        // FINALIZED remains a fence against provisional data, stale
        // generations, and same-generation identity conflicts. A Redis
        // rebuild may nevertheless create a newer complete FINAL publication
        // after the old checkpoint was retained; that validated successor is
        // the only allowed advancement of a durable FINAL checkpoint.
        if (!candidateIsValidFinalized) {
          return false;
        }
        const candidateGeneration = read.publication.generation;
        const currentGeneration = Number(current.generation);
        const generationCompatible = isLiveLeagueCheckpointGenerationCompatible(
          {
            generation: currentGeneration,
            publicationId: current.publicationId,
          },
          {
            generation: candidateGeneration,
            publicationId: read.publication.publicationId,
          },
        );
        if (!generationCompatible) return false;
        if (
          currentIsValidFinalized &&
          current.publicationId === read.publication.publicationId &&
          currentGeneration === candidateGeneration
        ) {
          // FINALIZED retries are common after the Redis marker is written.
          // Treat an exact identity replay as idempotent and avoid rewriting
          // the complete JSONB checkpoint payload.
          return true;
        }
        if (currentIsValidFinalized && !sameFinalizedPublicationContent(read, current)) {
          allowFinalizedRosterExpansion = isSafeFinalizedClassicRosterExpansion(read, current);
          if (!allowFinalizedRosterExpansion) return false;
        }
        if (!currentIsValidFinalized) {
          // A corrupt FINALIZED row may be repaired by the same validated
          // monotonic successor. It can never be replaced by provisional data
          // or a lower generation.
          currentIsInvalidFinalized = true;
          await tx
            .delete(liveLeagueCheckpointsInCompetition)
            .where(
              and(
                eq(liveLeagueCheckpointsInCompetition.seasonId, seasonId),
                eq(liveLeagueCheckpointsInCompetition.eventId, read.publication.eventId),
                eq(liveLeagueCheckpointsInCompetition.tournamentId, read.publication.tournamentId),
                eq(liveLeagueCheckpointsInCompetition.scopeKind, read.publication.scope),
              ),
            );
        }
      }
      if (
        current &&
        !currentIsInvalidFinalized &&
        !isLiveLeagueCheckpointGenerationCompatible(
          {
            generation: Number(current.generation),
            publicationId: current.publicationId,
          },
          {
            generation: read.publication.generation,
            publicationId: read.publication.publicationId,
          },
        )
      ) {
        return false;
      }
      const upserted = await tx
        .insert(liveLeagueCheckpointsInCompetition)
        .values({
          seasonId,
          eventId: read.publication.eventId,
          tournamentId: read.publication.tournamentId,
          scopeKind: read.publication.scope,
          publicationId: read.publication.publicationId,
          generation: read.publication.generation,
          state: read.publication.state,
          manifest: values.manifest,
          indexPayload: values.indexPayload,
          payload: values.payload,
          rowCount: values.rowCount,
          payloadBytes: values.payloadBytes,
          payloadSha256: values.payloadSha256,
          sourceCheckedAt: values.sourceCheckedAt,
          contentUpdatedAt: values.contentUpdatedAt,
          publishedAt: values.publishedAt,
          checkpointedAt: values.checkpointedAt,
          expectedNextCheckAt: values.expectedNextCheckAt,
          updatedAt: values.checkpointedAt,
        })
        .onConflictDoUpdate({
          target: [
            liveLeagueCheckpointsInCompetition.seasonId,
            liveLeagueCheckpointsInCompetition.eventId,
            liveLeagueCheckpointsInCompetition.tournamentId,
            liveLeagueCheckpointsInCompetition.scopeKind,
          ],
          set: {
            publicationId: sql`excluded.publication_id`,
            generation: sql`excluded.generation`,
            state: sql`excluded.state`,
            manifest: sql`excluded.manifest`,
            indexPayload: sql`excluded.index_payload`,
            payload: sql`excluded.payload`,
            rowCount: sql`excluded.row_count`,
            payloadBytes: sql`excluded.payload_bytes`,
            payloadSha256: sql`excluded.payload_sha256`,
            sourceCheckedAt: sql`excluded.source_checked_at`,
            contentUpdatedAt: sql`excluded.content_updated_at`,
            publishedAt: sql`excluded.published_at`,
            checkpointedAt: sql`excluded.checkpointed_at`,
            expectedNextCheckAt: sql`excluded.expected_next_check_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          where: sql`
            (
              ${liveLeagueCheckpointsInCompetition.publicationId} = excluded.publication_id
              AND ${liveLeagueCheckpointsInCompetition.generation} = excluded.generation
            )
            OR (
              ${liveLeagueCheckpointsInCompetition.state} = 'FINALIZED'
              AND excluded.state = 'FINALIZED'
              AND ${liveLeagueCheckpointsInCompetition.generation} < excluded.generation
              AND ${liveLeagueCheckpointsInCompetition.rowCount} = excluded.row_count
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'contractVersion' = excluded.manifest->'contractVersion'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'season' = excluded.manifest->'season'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'eventId' = excluded.manifest->'eventId'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'tournamentId' = excluded.manifest->'tournamentId'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'scope' = excluded.manifest->'scope'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'globalRef' = excluded.manifest->'globalRef'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'revisions' = excluded.manifest->'revisions'
              AND ${liveLeagueCheckpointsInCompetition.manifest}->'counts' = excluded.manifest->'counts'
            )
            OR (
              ${allowFinalizedRosterExpansion}
              AND ${liveLeagueCheckpointsInCompetition.state} = 'FINALIZED'
              AND excluded.state = 'FINALIZED'
              AND ${liveLeagueCheckpointsInCompetition.generation} < excluded.generation
            )
            OR (
              ${liveLeagueCheckpointsInCompetition.state} <> 'FINALIZED'
              AND ${liveLeagueCheckpointsInCompetition.generation} < excluded.generation
            )
          `,
        })
        .returning({ publicationId: liveLeagueCheckpointsInCompetition.publicationId });
      return upserted.length > 0;
    });
  } catch (error) {
    options.onInfrastructureFailure?.(error);
    logError('Live league publication checkpoint failed', error, {
      season: read.publication.season,
      eventId: read.publication.eventId,
      tournamentId: read.publication.tournamentId,
      scope: read.publication.scope,
      publicationId: read.publication.publicationId,
    });
    return false;
  }
}

/** Reconcile only the latest desired publication for one exact scope. */
export async function reconcileLiveLeagueCheckpointV2(
  scope: LeagueLiveScope,
  redisClient?: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<boolean> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const desired = await readLiveLeagueCheckpointDesiredV2(scope, redis);
  if (!desired) return false;
  const read = await readLiveLeaguePublicationV2(scope, redis);
  if (!read || read.publication.publicationId !== desired.publicationId) return false;
  if (!liveLeagueCheckpointIsDue(read, desired.force, desired.notBefore)) return false;
  const checkpointed = await checkpointLiveLeaguePublicationV2(read);
  if (!checkpointed) return false;
  const marked = await markLiveLeaguePublicationCheckpointedV2(read.publication, new Date(), redis);
  if (!marked) return false;
  await clearLiveLeagueCheckpointDesiredV2(desired, redis);
  return true;
}

/**
 * Reconcile only desired league checkpoints left behind by a failed inline
 * checkpoint. The producer remains the publication owner; this is a bounded
 * recovery pass and never creates a new publication or reads FPL.
 */
export async function reconcileLiveLeagueCheckpointObligationsV2(
  season: string,
): Promise<{ readonly scopes: number; readonly checkpointed: number; readonly failed: number }> {
  const scopes = await listLiveLeagueCheckpointDesiredScopesV2(season);
  let failed = 0;
  const results = await mapWithConcurrency(scopes, 2, async (scope) => {
    try {
      return await reconcileLiveLeagueCheckpointV2(scope);
    } catch (error) {
      failed += 1;
      logError('Live league checkpoint desired-scope reconciliation failed', error, {
        season,
        eventId: scope.eventId,
        tournamentId: scope.tournamentId,
        scope: scope.scope,
      });
      return false;
    }
  });
  return {
    scopes: scopes.length,
    checkpointed: results.filter(Boolean).length,
    failed,
  };
}

export function liveLeagueCheckpointIsDue(
  read: LeagueLiveRead,
  force = false,
  notBefore: string | null = null,
): boolean {
  return shouldCheckpoint(read, force, notBefore);
}
