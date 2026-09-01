import { and, desc, eq, sql } from 'drizzle-orm';

import { liveLeagueCheckpointsInCompetition } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  clearLiveLeagueCheckpointDesiredV2,
  markLiveLeaguePublicationCheckpointedV2,
  readLiveLeagueCheckpointDesiredV2,
  readLiveLeaguePublicationV2,
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

function shouldCheckpoint(candidate: LeagueLiveRead, force: boolean): boolean {
  if (force || candidate.publication.state === 'FINALIZED') return true;
  const checkpointedAt = candidate.publication.times.checkpointedAt;
  if (!checkpointedAt) return true;
  const time = Date.parse(checkpointedAt);
  return !Number.isFinite(time) || Date.now() - time >= CHECKPOINT_INTERVAL_MS;
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
      if (
        current &&
        (current.state === 'FINALIZED' || Number(current.generation) >= read.publication.generation)
      ) {
        return current.publicationId === read.publication.publicationId;
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
  if (!liveLeagueCheckpointIsDue(read, desired.force)) return false;
  const checkpointed = await checkpointLiveLeaguePublicationV2(read);
  if (!checkpointed) return false;
  const marked = await markLiveLeaguePublicationCheckpointedV2(read.publication, new Date(), redis);
  if (!marked) return false;
  await clearLiveLeagueCheckpointDesiredV2(desired, redis);
  return true;
}

export function liveLeagueCheckpointIsDue(read: LeagueLiveRead, force = false): boolean {
  return shouldCheckpoint(read, force);
}
