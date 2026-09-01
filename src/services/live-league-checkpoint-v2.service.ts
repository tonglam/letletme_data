import { and, desc, eq, sql } from 'drizzle-orm';

import { liveLeagueCheckpointsInCompetition } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  clearLiveLeagueCheckpointDesiredV2,
  markLiveLeaguePublicationCheckpointedV2,
  readLiveLeagueCheckpointDesiredV2,
  readLiveLeaguePublicationV2,
  validateLiveLeaguePublicationV2Checkpoint,
  type LeagueLiveRead,
  type LeagueLiveScope,
} from '../cache/live-league-publication-v2';
import { redisSingleton } from '../cache/singleton';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { logError } from '../utils/logger';

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
  // A Redis rebuild may allocate a fresh publication identity.  FINALIZED is
  // still immutable: accept only the same scope, global vector, revision
  // vector, counts, and semantic content identity; never replace the durable
  // row with a different final result.
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
export async function checkpointLiveLeaguePublicationV2(
  read: LeagueLiveRead,
  dbInstance?: DbOrTransaction,
): Promise<boolean> {
  if (read.publication.scope === 'H2H_MATCH') return false;
  const db = dbInstance ?? (await getDb());
  const values = checkpointValues(read, new Date());
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = 5000`);
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
      if (current && current.state === 'FINALIZED') {
        const scope = {
          season: read.publication.season,
          eventId: read.publication.eventId,
          tournamentId: read.publication.tournamentId,
          scope: read.publication.scope,
        } as const;
        if (
          storedFinalizedCheckpointIsValid(scope, current)
        ) {
          return (
            current.publicationId === read.publication.publicationId ||
            sameFinalizedPublicationContent(read, current)
          );
        }
        // A corrupt FINALIZED row is not a fence. Only another validated
        // FINALIZED publication may repair it; a provisional candidate must
        // never delete or supersede the durable final state.
        if (read.publication.state !== 'FINALIZED') return false;
        currentIsInvalidFinalized = true;
        const candidateValid = validateLiveLeaguePublicationV2Checkpoint(
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
        if (!candidateValid) return false;
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
          },
          where: sql`
            (
              ${liveLeagueCheckpointsInCompetition.publicationId} = excluded.publication_id
              AND ${liveLeagueCheckpointsInCompetition.generation} = excluded.generation
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
export async function reconcileLiveLeagueCheckpointV2(scope: LeagueLiveScope): Promise<boolean> {
  const redis = await redisSingleton.getClient();
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

export function liveLeagueCheckpointIsDue(
  read: LeagueLiveRead,
  force = false,
  notBefore: string | null = null,
): boolean {
  return shouldCheckpoint(read, force, notBefore);
}
