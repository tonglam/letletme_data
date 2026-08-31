import { and, eq, sql } from 'drizzle-orm';

import {
  liveMatchDeskCheckpointsInFpl,
  liveMatchDetailCheckpointsInFpl,
} from '../db/schemas/index.schema';
import { getDb, type TransactionHandle } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  clearLiveMatchCheckpointDesiredV2,
  isValidLiveMatchDeskPayloadV2,
  isValidLiveMatchDetailCheckpointPayloadV2,
  LIVE_MATCH_MAX_DESK_BYTES,
  LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES,
  LIVE_MATCH_MAX_FIXTURES,
  markLiveMatchDeskCheckpointedV2,
  markLiveMatchDetailCheckpointedV2,
  parseLiveMatchDeskPublicationV2,
  parseLiveMatchDetailPublicationV2,
  readLiveMatchCheckpointLastAtV2,
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchDeskV2,
  readLiveMatchDetailV2,
  type MatchCheckpointDesired,
  type MatchDeskPublication,
  type MatchDeskRead,
  type MatchDetailPublication,
  type MatchDetailRead,
} from '../cache/live-match-publication-v2';
import type { MatchDeskFixture, MatchFixtureDetail } from './live-match-v2';
import { canonicalJson, contentHash } from '../utils/content-hash';

type CheckpointClock = { checkpointed_at: Date | string };

const LIVE_MATCH_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

/**
 * Boundary and final obligations are durable urgency, not scheduler hints.
 * Keep this decision pure so the queue worker and its tests cannot accidentally
 * reintroduce the normal ten-minute coalescing gate after an obligation was
 * explicitly marked urgent.
 */
export function liveMatchCheckpointDue(
  desired: Pick<MatchCheckpointDesired, 'final' | 'force'>,
  lastCheckpointedAt: string | null,
  nowMs = Date.now(),
): boolean {
  if (desired.final || desired.force) return true;
  if (lastCheckpointedAt === null) return true;
  const lastMs = Date.parse(lastCheckpointedAt);
  return !Number.isFinite(lastMs) || nowMs - lastMs >= LIVE_MATCH_CHECKPOINT_INTERVAL_MS;
}

function checkpointClock(rows: readonly CheckpointClock[]): Date {
  const value = new Date(String(rows[0]?.checkpointed_at ?? ''));
  if (!Number.isFinite(value.getTime())) {
    throw new Error('PostgreSQL did not return a valid Live Matches checkpoint clock');
  }
  return value;
}

function asDate(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime()))
    throw new Error('Live Matches publication timestamp is invalid');
  return result;
}

function publicationIdentityMatches(
  publication: MatchDeskPublication | MatchDetailPublication,
  season: FplSeasonRef,
  eventId: number,
): void {
  if (publication.season !== season.seasonCode || publication.eventId !== eventId) {
    throw new Error('Live Matches checkpoint scope does not match publication');
  }
}

function assertDeskPayload(
  publication: MatchDeskPublication,
  fixtures: readonly MatchDeskFixture[],
): number {
  const payload = canonicalJson(fixtures);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (
    !isValidLiveMatchDeskPayloadV2(fixtures, publication.eventId) ||
    fixtures.length > LIVE_MATCH_MAX_FIXTURES ||
    bytes > LIVE_MATCH_MAX_DESK_BYTES ||
    publication.desk.count !== fixtures.length ||
    publication.desk.bytes !== bytes ||
    publication.desk.sha256 !== contentHash(fixtures)
  ) {
    throw new Error('Live Matches desk checkpoint payload does not match Redis manifest');
  }
  return bytes;
}

function assertDetailPayload(
  publication: MatchDetailPublication,
  fixtures: readonly MatchFixtureDetail[],
): number {
  const sorted = [...fixtures].sort((left, right) => left.fixtureId - right.fixtureId);
  const payload = canonicalJson(sorted);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (
    !isValidLiveMatchDetailCheckpointPayloadV2(sorted) ||
    sorted.length > LIVE_MATCH_MAX_FIXTURES ||
    bytes > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES ||
    publication.fixtures.length !== sorted.length ||
    contentHash(sorted) !== publication.detail.revision
  ) {
    throw new Error('Live Matches detail checkpoint payload does not match revision');
  }
  for (const [index, fixture] of sorted.entries()) {
    const item = publication.fixtures[index];
    const itemPayload = canonicalJson(fixture.players);
    if (
      !item ||
      item.fixtureId !== fixture.fixtureId ||
      item.count !== fixture.players.length ||
      item.bytes !== Buffer.byteLength(itemPayload, 'utf8') ||
      item.sha256 !== contentHash(fixture.players)
    ) {
      throw new Error(`Live Matches detail fixture ${fixture.fixtureId} does not match manifest`);
    }
  }
  return bytes;
}

export interface LiveMatchDeskCheckpointRequest {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly publication: MatchDeskPublication;
  readonly fixtures: readonly MatchDeskFixture[];
}

export interface LiveMatchDetailCheckpointRequest {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly publication: MatchDetailPublication;
  readonly fixtures: readonly MatchFixtureDetail[];
  readonly finalized?: boolean;
}

export async function checkpointLiveMatchScopeV2(input: {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly kind: 'desk' | 'detail';
}): Promise<{ checkpointed: boolean; skipped: boolean }> {
  const desired = await readLiveMatchCheckpointDesiredV2({
    kind: input.kind,
    season: input.season.seasonCode,
    eventId: input.eventId,
  });
  if (!desired) return { checkpointed: false, skipped: true };

  if (!desired.final) {
    const lastCheckpointedAt = await readLiveMatchCheckpointLastAtV2({
      kind: input.kind,
      season: input.season.seasonCode,
      eventId: input.eventId,
    });
    if (!liveMatchCheckpointDue(desired, lastCheckpointedAt)) {
      // The desired marker intentionally remains. A later observation will
      // enqueue the same scope after the coalescing window; no provider or DB
      // work is performed by this early queue completion.
      return { checkpointed: false, skipped: true };
    }
  }

  if (input.kind === 'desk') {
    const current = await readLiveMatchDeskV2({
      season: input.season.seasonCode,
      eventId: input.eventId,
    });
    if (
      !current ||
      current.servedFrom !== 'REDIS_CURRENT' ||
      current.publication.publicationId !== desired.publicationId ||
      current.publication.generation !== desired.generation
    ) {
      return { checkpointed: false, skipped: true };
    }
    const result = await checkpointLiveMatchDeskV2({
      season: input.season,
      eventId: input.eventId,
      publication: current.publication,
      fixtures: current.fixtures,
    });
    if (!result.checkpointed || !result.checkpointedAt)
      return { checkpointed: false, skipped: false };
    const marked = await markLiveMatchDeskCheckpointedV2(
      current.publication,
      result.checkpointedAt,
    );
    if (!marked) return { checkpointed: false, skipped: false };
    await clearLiveMatchCheckpointDesiredV2(desired);
    return { checkpointed: true, skipped: false };
  }

  const current = await readLiveMatchDetailV2({
    season: input.season.seasonCode,
    eventId: input.eventId,
  });
  if (
    !current ||
    current.servedFrom !== 'REDIS_CURRENT' ||
    current.publication.publicationId !== desired.publicationId ||
    current.publication.generation !== desired.generation
  ) {
    return { checkpointed: false, skipped: true };
  }
  const result = await checkpointLiveMatchDetailV2({
    season: input.season,
    eventId: input.eventId,
    publication: current.publication,
    fixtures: current.fixtures,
    finalized: desired.final,
  });
  if (!result.checkpointed || !result.checkpointedAt)
    return { checkpointed: false, skipped: false };
  const marked = await markLiveMatchDetailCheckpointedV2(
    current.publication,
    result.checkpointedAt,
  );
  if (!marked) return { checkpointed: false, skipped: false };
  await clearLiveMatchCheckpointDesiredV2(desired);
  return { checkpointed: true, skipped: false };
}

async function checkpointClockInTransaction<T>(
  callback: (tx: TransactionHandle) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    // Checkpointing is asynchronous compensation, never a reason to retain a
    // scarce runtime session behind a blocked statement. The latest desired
    // marker remains in Redis and the reconciler retries the exact scope.
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return callback(tx);
  });
}

/**
 * Persist one complete desk candidate. The provider and Redis operations are
 * intentionally outside this short transaction; Redis remains the serving
 * authority when this write is unavailable.
 */
export async function checkpointLiveMatchDeskV2(
  request: LiveMatchDeskCheckpointRequest,
): Promise<{ checkpointed: boolean; checkpointedAt: Date | null }> {
  const { season, eventId, publication, fixtures } = request;
  publicationIdentityMatches(publication, season, eventId);
  const bytes = assertDeskPayload(publication, fixtures);
  const checkpointedAt = await checkpointClockInTransaction(async (tx) => {
    const rows = await tx.execute<CheckpointClock>(
      sql`SELECT clock_timestamp() AS checkpointed_at`,
    );
    const clock = checkpointClock(rows);
    const result = await tx
      .insert(liveMatchDeskCheckpointsInFpl)
      .values({
        seasonId: season.seasonId,
        eventId,
        publicationId: publication.publicationId,
        generation: publication.generation,
        state: publication.state,
        manifest: { ...publication, checkpointedAt: clock.toISOString() },
        revisions: publication.revisions,
        payload: fixtures,
        rowCount: fixtures.length,
        payloadBytes: bytes,
        payloadSha256: publication.desk.sha256,
        sourceCheckedAt: asDate(publication.sourceCheckedAt),
        publishedAt: asDate(publication.publishedAt),
        checkpointedAt: clock,
        expectedNextCheckAt: publication.expectedNextCheckAt
          ? asDate(publication.expectedNextCheckAt)
          : null,
        staleAt: publication.staleAt ? asDate(publication.staleAt) : null,
      })
      .onConflictDoUpdate({
        target: [liveMatchDeskCheckpointsInFpl.seasonId, liveMatchDeskCheckpointsInFpl.eventId],
        set: {
          publicationId: sql`excluded.publication_id`,
          generation: sql`excluded.generation`,
          state: sql`excluded.state`,
          manifest: sql`excluded.manifest`,
          revisions: sql`excluded.revisions`,
          payload: sql`excluded.payload`,
          rowCount: sql`excluded.row_count`,
          payloadBytes: sql`excluded.payload_bytes`,
          payloadSha256: sql`excluded.payload_sha256`,
          sourceCheckedAt: sql`excluded.source_checked_at`,
          publishedAt: sql`excluded.published_at`,
          checkpointedAt: sql`excluded.checkpointed_at`,
          expectedNextCheckAt: sql`excluded.expected_next_check_at`,
          staleAt: sql`excluded.stale_at`,
        },
        where: sql`
          (
            ${liveMatchDeskCheckpointsInFpl.publicationId} = excluded.publication_id
            AND ${liveMatchDeskCheckpointsInFpl.generation} = excluded.generation
          )
          OR (
            ${liveMatchDeskCheckpointsInFpl.state} <> 'FINALIZED'
            AND ${liveMatchDeskCheckpointsInFpl.generation} < excluded.generation
          )
        `,
      })
      .returning({ eventId: liveMatchDeskCheckpointsInFpl.eventId });
    return result.length > 0 ? clock : null;
  });
  return { checkpointed: checkpointedAt !== null, checkpointedAt };
}

/** Persist one complete fixture-detail candidate with a final fence. */
export async function checkpointLiveMatchDetailV2(
  request: LiveMatchDetailCheckpointRequest,
): Promise<{ checkpointed: boolean; checkpointedAt: Date | null }> {
  const { season, eventId, publication, fixtures } = request;
  publicationIdentityMatches(publication, season, eventId);
  const finalized = request.finalized ?? publication.finalized;
  if (publication.finalized !== finalized) {
    throw new Error('Live Matches detail checkpoint finalization does not match publication');
  }
  const bytes = assertDetailPayload(publication, fixtures);
  if (
    !Number.isSafeInteger(publication.observedDeskGeneration) ||
    publication.observedDeskGeneration <= 0
  ) {
    throw new Error('Live Matches detail observed desk generation is invalid');
  }
  const checkpointedAt = await checkpointClockInTransaction(async (tx) => {
    const rows = await tx.execute<CheckpointClock>(
      sql`SELECT clock_timestamp() AS checkpointed_at`,
    );
    const clock = checkpointClock(rows);
    const result = await tx
      .insert(liveMatchDetailCheckpointsInFpl)
      .values({
        seasonId: season.seasonId,
        eventId,
        publicationId: publication.publicationId,
        generation: publication.generation,
        state: finalized ? 'FINALIZED' : 'PROVISIONAL',
        observedDeskGeneration: publication.observedDeskGeneration,
        fixtureIdentityRevision: publication.fixtureIdentityRevision,
        manifest: { ...publication, checkpointedAt: clock.toISOString() },
        revisions: { detail: publication.detail },
        payload: [...fixtures].sort((left, right) => left.fixtureId - right.fixtureId),
        rowCount: fixtures.length,
        payloadBytes: bytes,
        payloadSha256: contentHash(
          [...fixtures].sort((left, right) => left.fixtureId - right.fixtureId),
        ),
        sourceCheckedAt: asDate(publication.sourceCheckedAt),
        publishedAt: asDate(publication.publishedAt),
        checkpointedAt: clock,
        expectedNextCheckAt: publication.expectedNextCheckAt
          ? asDate(publication.expectedNextCheckAt)
          : null,
        staleAt: publication.staleAt ? asDate(publication.staleAt) : null,
      })
      .onConflictDoUpdate({
        target: [liveMatchDetailCheckpointsInFpl.seasonId, liveMatchDetailCheckpointsInFpl.eventId],
        set: {
          publicationId: sql`excluded.publication_id`,
          generation: sql`excluded.generation`,
          state: sql`excluded.state`,
          observedDeskGeneration: sql`excluded.observed_desk_generation`,
          fixtureIdentityRevision: sql`excluded.fixture_identity_revision`,
          manifest: sql`excluded.manifest`,
          revisions: sql`excluded.revisions`,
          payload: sql`excluded.payload`,
          rowCount: sql`excluded.row_count`,
          payloadBytes: sql`excluded.payload_bytes`,
          payloadSha256: sql`excluded.payload_sha256`,
          sourceCheckedAt: sql`excluded.source_checked_at`,
          publishedAt: sql`excluded.published_at`,
          checkpointedAt: sql`excluded.checkpointed_at`,
          expectedNextCheckAt: sql`excluded.expected_next_check_at`,
          staleAt: sql`excluded.stale_at`,
        },
        where: sql`
          (
            ${liveMatchDetailCheckpointsInFpl.publicationId} = excluded.publication_id
            AND ${liveMatchDetailCheckpointsInFpl.generation} = excluded.generation
          )
          OR (
            ${liveMatchDetailCheckpointsInFpl.state} <> 'FINALIZED'
            AND ${liveMatchDetailCheckpointsInFpl.generation} < excluded.generation
          )
        `,
      })
      .returning({ eventId: liveMatchDetailCheckpointsInFpl.eventId });
    return result.length > 0 ? clock : null;
  });
  return { checkpointed: checkpointedAt !== null, checkpointedAt };
}

function sameCheckpointTime(value: string | null, row: Date | null): boolean {
  return value === (row === null ? null : row.toISOString());
}

/** Read and fully validate the self-contained desk checkpoint used by protected repair. */
export async function readLiveMatchDeskCheckpointV2(
  season: FplSeasonRef,
  eventId: number,
): Promise<MatchDeskRead | null> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(liveMatchDeskCheckpointsInFpl)
      .where(
        and(
          eq(liveMatchDeskCheckpointsInFpl.seasonId, season.seasonId),
          eq(liveMatchDeskCheckpointsInFpl.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !row ||
    row.rowCount < 0 ||
    row.rowCount > LIVE_MATCH_MAX_FIXTURES ||
    row.payloadBytes < 0 ||
    row.payloadBytes > LIVE_MATCH_MAX_DESK_BYTES
  )
    return null;
  const scope = { season: season.seasonCode, eventId } as const;
  const publication = parseLiveMatchDeskPublicationV2(row.manifest, scope);
  const fixtures = row.payload;
  if (!publication || !isValidLiveMatchDeskPayloadV2(fixtures, eventId)) return null;
  const payload = canonicalJson(fixtures);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (
    row.publicationId !== publication.publicationId ||
    row.generation !== publication.generation ||
    row.state !== publication.state ||
    canonicalJson(row.revisions) !== canonicalJson(publication.revisions) ||
    row.rowCount !== fixtures.length ||
    row.payloadBytes !== payloadBytes ||
    row.payloadSha256 !== contentHash(fixtures) ||
    publication.desk.count !== fixtures.length ||
    publication.desk.bytes !== payloadBytes ||
    publication.desk.sha256 !== row.payloadSha256 ||
    publication.sourceCheckedAt !== row.sourceCheckedAt.toISOString() ||
    publication.publishedAt !== row.publishedAt.toISOString() ||
    !sameCheckpointTime(publication.checkpointedAt, row.checkpointedAt) ||
    !sameCheckpointTime(publication.expectedNextCheckAt, row.expectedNextCheckAt) ||
    !sameCheckpointTime(publication.staleAt, row.staleAt)
  )
    return null;
  return { publication, fixtures, servedFrom: 'POSTGRES_CHECKPOINT' };
}

/** Read and fully validate the exact fixture-detail manifest and payload checkpoint. */
export async function readLiveMatchDetailCheckpointV2(
  season: FplSeasonRef,
  eventId: number,
): Promise<MatchDetailRead | null> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return null;
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(liveMatchDetailCheckpointsInFpl)
      .where(
        and(
          eq(liveMatchDetailCheckpointsInFpl.seasonId, season.seasonId),
          eq(liveMatchDetailCheckpointsInFpl.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !row ||
    row.rowCount < 0 ||
    row.rowCount > LIVE_MATCH_MAX_FIXTURES ||
    row.payloadBytes < 0 ||
    row.payloadBytes > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES
  )
    return null;
  const scope = { season: season.seasonCode, eventId } as const;
  const publication = parseLiveMatchDetailPublicationV2(row.manifest, scope);
  const fixtures = row.payload;
  if (!publication || !isValidLiveMatchDetailCheckpointPayloadV2(fixtures)) return null;
  const payload = canonicalJson(fixtures);
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (
    row.publicationId !== publication.publicationId ||
    row.generation !== publication.generation ||
    row.state !== (publication.finalized ? 'FINALIZED' : 'PROVISIONAL') ||
    row.observedDeskGeneration !== publication.observedDeskGeneration ||
    row.fixtureIdentityRevision !== publication.fixtureIdentityRevision ||
    canonicalJson(row.revisions) !== canonicalJson({ detail: publication.detail }) ||
    row.rowCount !== fixtures.length ||
    row.payloadBytes !== payloadBytes ||
    row.payloadSha256 !== contentHash(fixtures) ||
    publication.detail.revision !== row.payloadSha256 ||
    publication.fixtures.length !== fixtures.length ||
    publication.sourceCheckedAt !== row.sourceCheckedAt.toISOString() ||
    publication.publishedAt !== row.publishedAt.toISOString() ||
    !sameCheckpointTime(publication.checkpointedAt, row.checkpointedAt) ||
    !sameCheckpointTime(publication.expectedNextCheckAt, row.expectedNextCheckAt) ||
    !sameCheckpointTime(publication.staleAt, row.staleAt)
  )
    return null;
  for (const [index, fixture] of fixtures.entries()) {
    const item = publication.fixtures[index];
    const playerPayload = canonicalJson(fixture.players);
    if (
      !item ||
      item.fixtureId !== fixture.fixtureId ||
      item.count !== fixture.players.length ||
      item.bytes !== Buffer.byteLength(playerPayload, 'utf8') ||
      item.sha256 !== contentHash(fixture.players)
    )
      return null;
  }
  return { publication, fixtures, servedFrom: 'POSTGRES_CHECKPOINT' };
}

/** Lightweight existence read for the reconciler; the serving GraphQL reader owns cold payload reads. */
export async function hasLiveMatchCheckpointV2(
  season: FplSeasonRef,
  eventId: number,
  kind: 'desk' | 'detail',
): Promise<boolean> {
  const db = await getDb();
  const table = kind === 'desk' ? liveMatchDeskCheckpointsInFpl : liveMatchDetailCheckpointsInFpl;
  const row = await db
    .select({ eventId: table.eventId })
    .from(table)
    .where(and(eq(table.seasonId, season.seasonId), eq(table.eventId, eventId)))
    .limit(1);
  return row.length > 0;
}

export function isExactFinalLiveMatchCheckpointPair(
  row:
    | {
        readonly deskState: string | null;
        readonly deskGeneration: number;
        readonly deskRevisions: unknown;
        readonly detailState: string | null;
        readonly detailObservedDeskGeneration: number | null;
        readonly detailFixtureIdentityRevision: string | null;
      }
    | undefined,
): boolean {
  const fixtureIdentity =
    row &&
    typeof row.deskRevisions === 'object' &&
    row.deskRevisions !== null &&
    'fixtureIdentity' in row.deskRevisions &&
    typeof row.deskRevisions.fixtureIdentity === 'object' &&
    row.deskRevisions.fixtureIdentity !== null &&
    'revision' in row.deskRevisions.fixtureIdentity &&
    typeof row.deskRevisions.fixtureIdentity.revision === 'string'
      ? row.deskRevisions.fixtureIdentity.revision
      : null;
  return Boolean(
    row?.deskState === 'FINALIZED' &&
      row.detailState === 'FINALIZED' &&
      row.detailObservedDeskGeneration !== null &&
      row.detailObservedDeskGeneration === row.deskGeneration &&
      fixtureIdentity !== null &&
      row.detailFixtureIdentityRevision === fixtureIdentity,
  );
}

/**
 * Finalization succeeds only when both independent Match publications are
 * durable and every self-contained manifest/payload checksum validates. The
 * lightweight joined-row identity is useful as a final fence, but it is not
 * durable proof on its own.
 */
export async function hasFinalLiveMatchCheckpointsV2(
  season: FplSeasonRef,
  eventId: number,
): Promise<boolean> {
  const [desk, detail] = await Promise.all([
    readLiveMatchDeskCheckpointV2(season, eventId),
    readLiveMatchDetailCheckpointV2(season, eventId),
  ]);
  if (!desk || !detail) return false;
  return isExactFinalLiveMatchCheckpointPair({
    deskState: desk.publication.state,
    deskGeneration: desk.publication.generation,
    deskRevisions: desk.publication.revisions,
    detailState: detail.publication.finalized ? 'FINALIZED' : 'PROVISIONAL',
    detailObservedDeskGeneration: detail.publication.observedDeskGeneration,
    detailFixtureIdentityRevision: detail.publication.fixtureIdentityRevision,
  });
}
