import { and, eq, sql } from 'drizzle-orm';

import {
  eventsInFpl,
  livePointsPublicationCheckpointsInCompetition,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { EventLive } from '../domain/event-lives';
import type { Fixture } from '../types';
import {
  liveV2ItemKey,
  type LivePublicationRead,
  type LivePublicationV2,
  type LivePublicationState,
} from '../cache/live-publication-v2';
import { canonicalJson, contentHash } from '../utils/content-hash';

export type LivePublicationV2CheckpointRequest = {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly publication: LivePublicationV2;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
};

const LIVE_PUBLICATION_STATES: readonly LivePublicationState[] = [
  'PRE_DEADLINE',
  'PICKS_WAIT',
  'PICKS_PROBE',
  'PICKS_SYNC',
  'LIVE_ACTIVE',
  'BETWEEN_FIXTURES',
  'DAY_SETTLING',
  'GW_REVIEW',
  'FINALIZED',
];

function isLivePublicationState(value: unknown): value is LivePublicationState {
  return (
    typeof value === 'string' && LIVE_PUBLICATION_STATES.includes(value as LivePublicationState)
  );
}

/**
 * PostgreSQL is the cold fallback only.  It returns the same complete
 * publication shape as Redis and validates the stored byte/hash/count proof
 * before exposing it to a caller.
 */
export async function readLivePublicationV2Checkpoint(
  season: FplSeasonRef,
  eventId: number,
): Promise<LivePublicationRead | null> {
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(livePointsPublicationCheckpointsInCompetition)
      .where(
        and(
          eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  if (!row || !isLivePublicationState(row.state) || !Number.isSafeInteger(row.generation))
    return null;
  if (!Array.isArray(row.eventLive) || !Array.isArray(row.fixtures)) return null;

  const eventLivePayload = canonicalJson(row.eventLive);
  const fixturePayload = canonicalJson(row.fixtures);
  if (
    row.eventLiveCount !== row.eventLive.length ||
    row.fixturesCount !== row.fixtures.length ||
    row.eventLiveBytes !== Buffer.byteLength(eventLivePayload, 'utf8') ||
    row.fixturesBytes !== Buffer.byteLength(fixturePayload, 'utf8') ||
    row.eventLiveSha256 !== contentHash(row.eventLive) ||
    row.fixturesSha256 !== contentHash(row.fixtures)
  )
    return null;

  const publication: LivePublicationV2 = {
    contractVersion: 'live-points-v2',
    publicationId: row.publicationId,
    generation: row.generation,
    season: season.seasonCode,
    eventId,
    state: row.state,
    sourceCheckedAt: row.sourceCheckedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    checkpointedAt: row.checkpointedAt.toISOString(),
    expectedNextCheckAt: row.expectedNextCheckAt?.toISOString() ?? null,
    revisions: row.revisions as LivePublicationV2['revisions'],
    items: {
      eventLive: {
        name: 'eventLive',
        key: liveV2ItemKey({ season: season.seasonCode, eventId }, row.generation, 'eventLive'),
        type: 'string',
        count: row.eventLiveCount,
        bytes: row.eventLiveBytes,
        sha256: row.eventLiveSha256,
      },
      fixtures: {
        name: 'fixtures',
        key: liveV2ItemKey({ season: season.seasonCode, eventId }, row.generation, 'fixtures'),
        type: 'string',
        count: row.fixturesCount,
        bytes: row.fixturesBytes,
        sha256: row.fixturesSha256,
      },
    },
  };
  return {
    publication,
    eventLives: row.eventLive as LivePublicationRead['eventLives'],
    fixtures: row.fixtures as LivePublicationRead['fixtures'],
    servedFrom: 'POSTGRES_CHECKPOINT',
  };
}

/**
 * Checkpoint one complete Redis publication without making PostgreSQL part of
 * the serving path.  Upstream fetches and Redis promotion must already have
 * completed before this short transaction starts.
 */
export async function checkpointLivePublicationV2(
  request: LivePublicationV2CheckpointRequest,
): Promise<boolean> {
  const { season, eventId, publication, eventLives, fixtures } = request;
  if (
    publication.season !== season.seasonCode ||
    publication.eventId !== eventId ||
    publication.state === undefined
  ) {
    throw new Error('Live Points V2 checkpoint scope does not match publication');
  }
  if (publication.items.eventLive.count !== eventLives.length) {
    throw new Error('Live Points V2 event-live checkpoint count does not match manifest');
  }
  if (publication.items.fixtures.count !== fixtures.length) {
    throw new Error('Live Points V2 fixture checkpoint count does not match manifest');
  }

  const eventLivePayload = canonicalJson(eventLives);
  const fixturePayload = canonicalJson(fixtures);
  const eventLiveBytes = Buffer.byteLength(eventLivePayload, 'utf8');
  const fixtureBytes = Buffer.byteLength(fixturePayload, 'utf8');
  if (
    eventLiveBytes !== publication.items.eventLive.bytes ||
    fixtureBytes !== publication.items.fixtures.bytes ||
    contentHash(eventLives) !== publication.items.eventLive.sha256 ||
    contentHash(fixtures) !== publication.items.fixtures.sha256
  ) {
    throw new Error('Live Points V2 checkpoint payload failed manifest validation');
  }

  const checkpointedAt = new Date();
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    // Redis-first checkpoint obligations can race with a scheduler retry or a
    // finalization worker. Serialize the scope before applying the generation
    // and FINAL fences; a row lock alone cannot protect the initial insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const existing = await tx
      .select({
        publicationId: livePointsPublicationCheckpointsInCompetition.publicationId,
        generation: livePointsPublicationCheckpointsInCompetition.generation,
        state: livePointsPublicationCheckpointsInCompetition.state,
      })
      .from(livePointsPublicationCheckpointsInCompetition)
      .where(
        and(
          eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
        ),
      )
      .for('update')
      .limit(1);
    const winner = existing[0];
    if (
      winner &&
      winner.publicationId !== publication.publicationId &&
      (winner.state === 'FINALIZED' || winner.generation >= publication.generation)
    ) {
      return false;
    }

    await tx
      .insert(livePointsPublicationCheckpointsInCompetition)
      .values({
        seasonId: season.seasonId,
        eventId,
        publicationId: publication.publicationId,
        generation: publication.generation,
        state: publication.state,
        sourceCheckedAt: new Date(publication.sourceCheckedAt),
        publishedAt: new Date(publication.publishedAt),
        checkpointedAt,
        expectedNextCheckAt: publication.expectedNextCheckAt
          ? new Date(publication.expectedNextCheckAt)
          : null,
        revisions: publication.revisions,
        eventLive: eventLives,
        fixtures,
        eventLiveBytes,
        fixturesBytes: fixtureBytes,
        eventLiveSha256: publication.items.eventLive.sha256,
        fixturesSha256: publication.items.fixtures.sha256,
        eventLiveCount: eventLives.length,
        fixturesCount: fixtures.length,
      })
      .onConflictDoUpdate({
        target: [
          livePointsPublicationCheckpointsInCompetition.seasonId,
          livePointsPublicationCheckpointsInCompetition.eventId,
        ],
        set: {
          publicationId: sql`excluded.publication_id`,
          generation: sql`excluded.generation`,
          state: sql`excluded.state`,
          sourceCheckedAt: sql`excluded.source_checked_at`,
          publishedAt: sql`excluded.published_at`,
          checkpointedAt: sql`excluded.checkpointed_at`,
          expectedNextCheckAt: sql`excluded.expected_next_check_at`,
          revisions: sql`excluded.revisions`,
          eventLive: sql`excluded.event_live`,
          fixtures: sql`excluded.fixtures`,
          eventLiveBytes: sql`excluded.event_live_bytes`,
          fixturesBytes: sql`excluded.fixtures_bytes`,
          eventLiveSha256: sql`excluded.event_live_sha256`,
          fixturesSha256: sql`excluded.fixtures_sha256`,
          eventLiveCount: sql`excluded.event_live_count`,
          fixturesCount: sql`excluded.fixtures_count`,
        },
      });
    if (publication.state === 'FINALIZED') {
      // The V2 checkpoint is the finalization boundary. Keep the existing
      // checked timestamp invariant intact when a late core heartbeat won the
      // race with this durable final write.
      await tx
        .update(eventsInFpl)
        .set({
          liveSnapshotFinalizedAt: sql`
            GREATEST(
              COALESCE(${eventsInFpl.liveSnapshotFinalizedAt}, ${checkpointedAt}),
              COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${checkpointedAt})
            )
          `,
          updatedAt: checkpointedAt,
        })
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)));
    }
    return true;
  });
}
