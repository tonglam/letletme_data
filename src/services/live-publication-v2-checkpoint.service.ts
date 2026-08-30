import { randomUUID } from 'node:crypto';

import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

import {
  eventsInFpl,
  livePointsPublicationCheckpointsInCompetition,
  livePointsPublicationSeedClaimsInCompetition,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { EventLive } from '../domain/event-lives';
import type { EventLiveExplain } from '../domain/event-live-explains';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';
import { validateSerializedFixtures } from '../domain/fixtures';
import type { Fixture } from '../types';
import { createFixtureRepository } from '../repositories/fixtures';
import { createEventLiveRepository } from '../repositories/event-lives';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createFplPlayerFixtureStatsRepository } from '../repositories/fpl-player-fixture-stats';
import { CORE_SNAPSHOT_WRITE_LOCK_KEY } from './core-snapshot-persistence.service';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';
import {
  liveV2ItemKey,
  type LivePublicationRead,
  type LivePublicationV2,
  type LivePublicationState,
} from '../cache/live-publication-v2';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { logError } from '../utils/logger';

export type LivePublicationV2CheckpointRequest = {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly publication: LivePublicationV2;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
  /** Facts captured with the same coherent FPL response. */
  readonly explains: readonly EventLiveExplain[];
  readonly fixtureEvidence: readonly FplPlayerFixtureEvidence[];
  /**
   * Fresh observation time used for the ordering fence. A recovery can
   * re-verify an immutable FINAL publication after its original source check;
   * the publication timestamp stays part of that identity, while this time
   * proves the facts were observed after the current relational authority.
   */
  readonly observationCheckedAt?: Date | string;
  /**
   * Seed recovery uses an absent durable head as part of its eligibility
   * proof. Enforce that proof only after taking the scope advisory lock so a
   * concurrent normal checkpoint cannot commit between the check and insert.
   */
  readonly requireMissingCheckpoint?: boolean;
  /** Exact durable seed claim acquired before the Redis active switch. */
  readonly seedClaimId?: string;
};

export type LivePublicationV2SeedClaim = {
  readonly claimId: string;
  readonly expectedActiveSha256: string;
  readonly candidateState: LivePublicationState;
  readonly candidateSourceCheckedAt: string;
  readonly candidateEventLiveSha256: string;
  readonly candidateFixturesSha256: string;
  readonly claimedAt: string;
};

export type LivePublicationV2SeedCandidate = Omit<
  LivePublicationV2SeedClaim,
  'claimId' | 'expectedActiveSha256' | 'claimedAt'
>;

// After the claim commits, promotion performs only bounded Redis commands
// (5-second command timeout each). One minute is therefore a conservative
// ownership lease, not a publication cadence or freshness threshold.
export const LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS = 60_000;

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

/**
 * Drizzle raw SQL fragments are bound by postgres-js without the timestamp
 * encoder used for typed table values. Bind a canonical ISO string instead of
 * a Date whenever a timestamp is interpolated into sql``.
 */
export function postgresTimestampParameter(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('PostgreSQL timestamp parameter is invalid');
  }
  return value.toISOString();
}

function isLivePublicationState(value: unknown): value is LivePublicationState {
  return (
    typeof value === 'string' && LIVE_PUBLICATION_STATES.includes(value as LivePublicationState)
  );
}

export function livePublicationSeedClaimAllowsCheckpoint(
  persistedClaimId: string | null,
  requestedClaimId: string | undefined,
): boolean {
  return persistedClaimId === null
    ? requestedClaimId === undefined
    : requestedClaimId === persistedClaimId;
}

export function livePublicationSeedClaimMatchesPublication(
  claim: LivePublicationV2SeedClaim,
  publication: LivePublicationV2,
): boolean {
  return (
    claim.candidateState === publication.state &&
    claim.candidateSourceCheckedAt === publication.sourceCheckedAt &&
    claim.candidateEventLiveSha256 === publication.items.eventLive.sha256 &&
    claim.candidateFixturesSha256 === publication.items.fixtures.sha256
  );
}

export function livePublicationSeedClaimMatchesCandidate(
  claim: LivePublicationV2SeedClaim,
  candidate: LivePublicationV2SeedCandidate,
): boolean {
  return (
    claim.candidateState === candidate.candidateState &&
    claim.candidateSourceCheckedAt === candidate.candidateSourceCheckedAt &&
    claim.candidateEventLiveSha256 === candidate.candidateEventLiveSha256 &&
    claim.candidateFixturesSha256 === candidate.candidateFixturesSha256
  );
}

export async function readLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
): Promise<LivePublicationV2SeedClaim | null> {
  const db = await getDb();
  const row = (
    await db
      .select({
        claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
        expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
        candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
        candidateSourceCheckedAt:
          livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
        candidateEventLiveSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
        candidateFixturesSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
        claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
      })
      .from(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  return row
    ? {
        ...row,
        candidateState: row.candidateState as LivePublicationState,
        candidateSourceCheckedAt: row.candidateSourceCheckedAt.toISOString(),
        claimedAt: row.claimedAt.toISOString(),
      }
    : null;
}

/** Commit the seed's absence claim before any Redis pointer can change. */
export async function acquireLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  expectedActiveSha256: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<
  | { readonly status: 'claimed'; readonly claim: LivePublicationV2SeedClaim }
  | { readonly status: 'durable'; readonly claim: null }
  | { readonly status: 'blocked'; readonly claim: null }
> {
  if (!/^[0-9a-f]{64}$/.test(expectedActiveSha256)) {
    throw new Error('Live Points V2 seed claim active hash is invalid');
  }
  if (
    !LIVE_PUBLICATION_STATES.includes(candidate.candidateState) ||
    !Number.isFinite(Date.parse(candidate.candidateSourceCheckedAt)) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateEventLiveSha256) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateFixturesSha256)
  ) {
    throw new Error('Live Points V2 seed claim candidate is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const durable = await tx
      .select({ publicationId: livePointsPublicationCheckpointsInCompetition.publicationId })
      .from(livePointsPublicationCheckpointsInCompetition)
      .where(
        and(
          eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
        ),
      )
      .for('update')
      .limit(1);
    if (durable[0]) return { status: 'durable', claim: null } as const;

    const existing = await tx
      .select({
        claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
        expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
        candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
        candidateSourceCheckedAt:
          livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
        candidateEventLiveSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
        candidateFixturesSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
        claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
      })
      .from(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
        ),
      )
      .for('update')
      .limit(1);
    const prior = existing[0];
    if (prior) {
      const normalizedPrior: LivePublicationV2SeedClaim = {
        ...prior,
        candidateState: prior.candidateState as LivePublicationState,
        candidateSourceCheckedAt: prior.candidateSourceCheckedAt.toISOString(),
        claimedAt: prior.claimedAt.toISOString(),
      };
      if (
        prior.expectedActiveSha256 !== expectedActiveSha256 ||
        !livePublicationSeedClaimMatchesCandidate(normalizedPrior, candidate)
      ) {
        return { status: 'blocked', claim: null } as const;
      }

      // A retry may arrive after the previous owner abandoned the same claim.
      // Rotate the ownership token and renew the lease using PostgreSQL time;
      // an old owner can no longer checkpoint after this transaction commits.
      // An unexpired retry keeps the existing token so concurrent executions
      // of the exact candidate do not invalidate an owner still promoting it.
      const renewedClaimId = randomUUID();
      const renewed = (
        await tx
          .update(livePointsPublicationSeedClaimsInCompetition)
          .set({
            claimId: renewedClaimId,
            claimedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
              eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
              eq(livePointsPublicationSeedClaimsInCompetition.claimId, prior.claimId),
              sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          )
          .returning({ claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt })
      )[0];
      return {
        status: 'claimed',
        claim: renewed
          ? {
              ...normalizedPrior,
              claimId: renewedClaimId,
              claimedAt: renewed.claimedAt.toISOString(),
            }
          : normalizedPrior,
      } as const;
    }

    const claimId = randomUUID();
    const inserted = (
      await tx
        .insert(livePointsPublicationSeedClaimsInCompetition)
        .values({
          seasonId: season.seasonId,
          eventId,
          claimId,
          expectedActiveSha256,
          candidateState: candidate.candidateState,
          candidateSourceCheckedAt: new Date(candidate.candidateSourceCheckedAt),
          candidateEventLiveSha256: candidate.candidateEventLiveSha256,
          candidateFixturesSha256: candidate.candidateFixturesSha256,
        })
        .returning({ claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt })
    )[0];
    if (!inserted) throw new Error('Live Points V2 seed claim insert returned no row');
    const claim: LivePublicationV2SeedClaim = {
      claimId,
      expectedActiveSha256,
      ...candidate,
      claimedAt: inserted.claimedAt.toISOString(),
    };
    return { status: 'claimed', claim } as const;
  });
}

export async function releaseLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
}

/**
 * Reclaim only an expired claim that still describes the exact active bytes
 * observed before its abandoned promotion and whose candidate no longer
 * matches this seed. The claim id is the ownership token; a delayed old owner
 * cannot checkpoint after this exact row is deleted.
 */
export async function reclaimAbandonedLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
  observedActiveSha256: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(observedActiveSha256)) {
    throw new Error('Live Points V2 abandoned claim active hash is invalid');
  }
  const candidateSourceCheckedAt = new Date(candidate.candidateSourceCheckedAt);
  if (!Number.isFinite(candidateSourceCheckedAt.getTime())) {
    throw new Error('Live Points V2 abandoned claim candidate timestamp is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
          eq(
            livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
            observedActiveSha256,
          ),
          sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
          sql`${livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt} <= ${candidateSourceCheckedAt.toISOString()}::timestamptz`,
          sql`(${livePointsPublicationSeedClaimsInCompetition.candidateState} <> 'FINALIZED' OR ${candidate.candidateState} = 'FINALIZED')`,
          or(
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateState,
              candidate.candidateState,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
              candidateSourceCheckedAt,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
              candidate.candidateEventLiveSha256,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
              candidate.candidateFixturesSha256,
            ),
          ),
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
}

/**
 * Reclaim a claim whose candidate is already the Redis active publication but
 * whose owner abandoned the durable checkpoint, including a retry of the
 * same candidate.  The checkpoint transaction
 * takes this same scope lock before it can wait on the shared Core lock, so an
 * in-flight owner retains its exact claim even after the wall-clock lease has
 * elapsed.  PostgreSQL owns both the lease clock and the compare/delete.
 */
export async function reclaimAbandonedPromotedLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<boolean> {
  const candidateSourceCheckedAt = new Date(candidate.candidateSourceCheckedAt);
  if (
    !LIVE_PUBLICATION_STATES.includes(candidate.candidateState) ||
    !Number.isFinite(candidateSourceCheckedAt.getTime()) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateEventLiveSha256) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateFixturesSha256)
  ) {
    throw new Error('Live Points V2 abandoned promoted claim candidate is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
          sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
          sql`${livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt} <= ${candidateSourceCheckedAt.toISOString()}::timestamptz`,
          sql`(${livePointsPublicationSeedClaimsInCompetition.candidateState} <> 'FINALIZED' OR ${candidate.candidateState} = 'FINALIZED')`,
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
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

  let fixtures: Fixture[];
  try {
    // PostgreSQL JSONB has the same wire shape as Redis JSON. Rehydrate the
    // date-bearing fixture fields before a checkpoint is handed to writers or
    // projection code.
    fixtures = validateSerializedFixtures(row.fixtures);
  } catch {
    return null;
  }

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
    fixtures,
    servedFrom: 'POSTGRES_CHECKPOINT',
  };
}

/**
 * Return every terminal event whose V2 checkpoint is absent or not FINALIZED.
 * This is one set-based query so a scheduler restart can catch up an older
 * event without issuing one checkpoint lookup per historical gameweek.
 */
export async function findLivePublicationV2FinalizationTargets(
  season: FplSeasonRef,
): Promise<number[]> {
  const db = await getDb();
  const rows = await db
    .select({ eventId: eventsInFpl.eventId })
    .from(eventsInFpl)
    .leftJoin(
      livePointsPublicationCheckpointsInCompetition,
      and(
        eq(livePointsPublicationCheckpointsInCompetition.seasonId, eventsInFpl.seasonId),
        eq(livePointsPublicationCheckpointsInCompetition.eventId, eventsInFpl.eventId),
      ),
    )
    .where(
      and(
        eq(eventsInFpl.seasonId, season.seasonId),
        eq(eventsInFpl.finished, true),
        eq(eventsInFpl.dataChecked, true),
        or(
          isNull(livePointsPublicationCheckpointsInCompetition.eventId),
          ne(livePointsPublicationCheckpointsInCompetition.state, 'FINALIZED'),
        ),
      ),
    )
    .orderBy(eventsInFpl.eventId);
  return rows.map((row) => row.eventId);
}

/**
 * Checkpoint one complete Redis publication without making PostgreSQL part of
 * the serving path.  Upstream fetches and Redis promotion must already have
 * completed before this short transaction starts.
 */
export async function checkpointLivePublicationV2(
  request: LivePublicationV2CheckpointRequest,
): Promise<boolean> {
  const { season, eventId, publication, eventLives, fixtures, explains, fixtureEvidence } = request;
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
  if (
    explains.some((row) => row.eventId !== eventId) ||
    fixtureEvidence.some((row) => row.eventId !== eventId)
  ) {
    throw new Error('Live Points V2 checkpoint facts contain another event');
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

  const sourceCheckedAt = new Date(publication.sourceCheckedAt);
  const observationCheckedAt =
    request.observationCheckedAt instanceof Date
      ? new Date(request.observationCheckedAt.getTime())
      : request.observationCheckedAt === undefined
        ? new Date(sourceCheckedAt.getTime())
        : new Date(request.observationCheckedAt);
  if (
    !Number.isFinite(sourceCheckedAt.getTime()) ||
    !Number.isFinite(observationCheckedAt.getTime())
  ) {
    throw new Error('Live Points V2 checkpoint source timestamp is invalid');
  }
  const db = await getDb();
  return db
    .transaction(async (tx) => {
      const scopeLock = `${season.seasonCode}:${eventId}`;
      // Claim ownership and generation/final ordering are scope-local. Take
      // this lock first so an already-started checkpoint cannot lose its claim
      // merely because it waits on the shared Core publication lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
      // Core publication writes use this same lock before touching events or
      // fixtures. Scope -> Core is safe because Core-only writers never wait
      // for a live scope lock, and it keeps the source fence and mutations in
      // one ordering domain.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CORE_SNAPSHOT_WRITE_LOCK_KEY})`);
      // publishedAt comes from Redis TIME. checkpointedAt is deliberately
      // obtained from the same PostgreSQL clock that owns the durable row;
      // never compare or synthesize the durable timestamp from an app host.
      const clockRows = await tx.execute<{ checkpointed_at: Date | string }>(
        sql`SELECT clock_timestamp() AS checkpointed_at`,
      );
      const checkpointedAt = new Date(String(clockRows[0]?.checkpointed_at ?? ''));
      if (!Number.isFinite(checkpointedAt.getTime())) {
        throw new Error('PostgreSQL did not return a valid checkpoint clock timestamp');
      }
      const observationCheckedAtParameter = postgresTimestampParameter(observationCheckedAt);
      const checkpointedAtParameter = postgresTimestampParameter(checkpointedAt);
      const seedClaims = await tx
        .select({
          claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
          expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
          candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
          candidateSourceCheckedAt:
            livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
          candidateEventLiveSha256:
            livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
          candidateFixturesSha256:
            livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
          claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
        })
        .from(livePointsPublicationSeedClaimsInCompetition)
        .where(
          and(
            eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
            eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          ),
        )
        .for('update')
        .limit(1);
      const seedClaimId = seedClaims[0]?.claimId ?? null;
      const seedClaim = seedClaims[0]
        ? ({
            ...seedClaims[0],
            candidateState: seedClaims[0].candidateState as LivePublicationState,
            candidateSourceCheckedAt: seedClaims[0].candidateSourceCheckedAt.toISOString(),
            claimedAt: seedClaims[0].claimedAt.toISOString(),
          } satisfies LivePublicationV2SeedClaim)
        : null;
      if (
        !livePublicationSeedClaimAllowsCheckpoint(seedClaimId, request.seedClaimId) ||
        (seedClaim !== null && !livePublicationSeedClaimMatchesPublication(seedClaim, publication))
      ) {
        return false;
      }
      const [eventAuthority] = await tx
        .select({ liveSnapshotCheckedAt: eventsInFpl.liveSnapshotCheckedAt })
        .from(eventsInFpl)
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
        .for('update')
        .limit(1);
      if (
        eventAuthority?.liveSnapshotCheckedAt &&
        eventAuthority.liveSnapshotCheckedAt.getTime() > observationCheckedAt.getTime()
      ) {
        // A newer Core transaction already owns the canonical fixture state.
        // Reject the older live publication as a whole; otherwise its fixture
        // upsert could move a finished fixture back to started even though the
        // event freshness marker remains newer.
        return false;
      }
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
      if (request.requireMissingCheckpoint && winner) {
        return false;
      }
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
          sourceCheckedAt,
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

      // A V2 checkpoint is also the successful coherent-source observation for
      // the canonical FPL tables. Keep event lives, explains, fixture evidence,
      // fixture rows, and freshness markers in the same short transaction as the
      // checkpoint head so recovery cannot expose a durable publication while
      // core reconciliation still points at an older fact set.
      const savedLives = await createEventLiveRepository(tx).upsertBatch(season, [...eventLives]);
      if (savedLives.length !== eventLives.length) {
        throw new Error(
          `Incomplete event live checkpoint: expected ${eventLives.length}, persisted ${savedLives.length}`,
        );
      }
      await createEventLiveExplainsRepository(tx).replaceEvent(season, [...explains]);
      await createFplPlayerFixtureStatsRepository(tx).upsertEvidence(season, [...fixtureEvidence]);
      await createFixtureRepository(tx).upsertBatch(season, [...fixtures]);
      await tx
        .update(eventsInFpl)
        .set({
          liveSnapshotCheckedAt: sql`
          GREATEST(
            COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${observationCheckedAtParameter}::timestamptz),
            ${observationCheckedAtParameter}::timestamptz
          )
        `,
          liveFactsPersistedAt: checkpointedAt,
          updatedAt: checkpointedAt,
        })
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)));
      if (publication.state === 'FINALIZED') {
        // The V2 checkpoint is the finalization boundary. Keep the existing
        // checked timestamp invariant intact when a late core heartbeat won the
        // race with this durable final write.
        await tx
          .update(eventsInFpl)
          .set({
            liveSnapshotFinalizedAt: sql`
            GREATEST(
              COALESCE(${eventsInFpl.liveSnapshotFinalizedAt}, ${checkpointedAtParameter}::timestamptz),
              COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${observationCheckedAtParameter}::timestamptz),
              ${observationCheckedAtParameter}::timestamptz
            )
          `,
            updatedAt: checkpointedAt,
          })
          .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)));
      }
      if (request.seedClaimId) {
        const removedClaims = await tx
          .delete(livePointsPublicationSeedClaimsInCompetition)
          .where(
            and(
              eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
              eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
              eq(livePointsPublicationSeedClaimsInCompetition.claimId, request.seedClaimId),
            ),
          )
          .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
        if (removedClaims.length !== 1) {
          throw new Error('Live Points V2 seed claim disappeared before checkpoint commit');
        }
      }
      return true;
    })
    .then(async (committed) => {
      if (committed) {
        // The reporting projection is deliberately refreshed only after the
        // authoritative transaction commits. Its failure must not invalidate a
        // Redis-first publication; the bounded repair lane can retry it.
        try {
          await refreshPlayerSeasonSummaries(season);
        } catch (error) {
          logError('Player season summary refresh failed after V2 checkpoint', error, {
            season: season.seasonCode,
            eventId,
          });
        }
      }
      return committed;
    });
}
