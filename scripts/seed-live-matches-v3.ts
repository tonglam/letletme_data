/* eslint-disable no-console */

import { fplClient } from '../src/clients/fpl';
import { explicitSeasonRef } from '../src/domain/fpl-season';
import { isCanonicalPlayerPrice } from '../src/domain/players';
import { eventRepository } from '../src/repositories/events';
import { seasonRepository } from '../src/repositories/seasons';
import {
  readLiveMatchDeskCheckpointV3,
  readLiveMatchDetailCheckpointV3,
  checkpointLiveMatchScopeV3,
} from '../src/services/live-match-v3-checkpoint.service';
import {
  readLiveMatchCheckpointDesiredV3,
  readLiveMatchDeskPointerV3,
  readLiveMatchDetailPointerV3,
  setLiveMatchCheckpointDesiredV3,
  type MatchDeskRead,
  type MatchDetailRead,
} from '../src/cache/live-match-publication-v3';
import { decideLiveLifecycle } from '../src/services/live-lifecycle-orchestrator';
import {
  syncLiveSnapshotV2,
  type LiveSnapshotV2SyncResult,
} from '../src/services/live-snapshot-v2.service';
import type { MatchLifecycleState } from '../src/services/live-match-v3';
import { databaseSingleton } from '../src/db/singleton';
import { closeLiveDataQueue } from '../src/queues/live-data.queue';
import { redisSingleton } from '../src/cache/singleton';
import type { Event, RawFPLFixture } from '../src/types';

export type LiveMatchSeedArguments = {
  readonly execute: boolean;
  readonly allFinalized: boolean;
  readonly season: string | null;
  readonly eventId: number | null;
};

const SEED_CLEANUP_TIMEOUT_MS = 5_000;

function usage(): never {
  throw new Error(
    'usage: bun scripts/seed-live-matches-v3.ts --execute --season YYYY [--event-id N] [--all-finalized]',
  );
}

export function parseLiveMatchSeedArguments(argv: readonly string[]): LiveMatchSeedArguments {
  let execute = false;
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
  if (!execute || season === null || (!allFinalized && eventId === null)) usage();
  return { execute, allFinalized, season, eventId };
}

function hasCanonicalPrices(
  fixtures: readonly { readonly players: readonly { readonly price: number }[] }[],
): boolean {
  return fixtures.every((fixture) =>
    fixture.players.every((player) => isCanonicalPlayerPrice(player.price)),
  );
}

type FinalSeedDeskCheckpoint = Pick<MatchDeskRead, 'fixtures'> & {
  readonly publication: Pick<MatchDeskRead['publication'], 'generation' | 'state' | 'revisions'>;
};

type FinalSeedDetailCheckpoint = Pick<MatchDetailRead, 'fixtures'> & {
  readonly publication: Pick<
    MatchDetailRead['publication'],
    'finalized' | 'fixtureIdentityRevision' | 'generation' | 'observedDeskGeneration'
  >;
};

/**
 * FINAL checkpoints are immutable. A deploy must reuse a complete durable
 * result instead of re-observing an old event and manufacturing a publication
 * that the final fence is correctly unable to overwrite.
 */
export function reusableFinalLiveMatchSeed(
  desk: FinalSeedDeskCheckpoint | null,
  detail: FinalSeedDetailCheckpoint | null,
): {
  readonly status: 'already-checkpointed' | 'no-player-detail';
  readonly generation: number;
} | null {
  if (!desk || desk.publication.state !== 'FINALIZED') return null;
  if (desk.fixtures.length === 0) {
    return { status: 'no-player-detail', generation: desk.publication.generation };
  }
  if (
    !detail ||
    detail.publication.finalized !== true ||
    detail.publication.observedDeskGeneration !== desk.publication.generation ||
    detail.publication.fixtureIdentityRevision !==
      desk.publication.revisions.fixtureIdentity.revision ||
    detail.fixtures.length !== desk.fixtures.length ||
    !hasCanonicalPrices(detail.fixtures)
  ) {
    return null;
  }
  return { status: 'already-checkpointed', generation: detail.publication.generation };
}

type FinalizationEvent = Pick<Event, 'finished' | 'dataChecked' | 'dataCheckedAt' | 'deadlineTime'>;

/**
 * The cutover seed must use the same all-fixtures-finished fence as the live
 * scheduler. Event-level finished/dataChecked flags alone are not enough:
 * FPL can mark the event while one fixture still has provisional facts.
 */
export function canFinalizeLiveMatchSeed(
  event: FinalizationEvent,
  fixtures: readonly Pick<
    RawFPLFixture,
    'started' | 'finished' | 'finished_provisional' | 'kickoff_time'
  >[],
): boolean {
  if (!event.finished || !event.dataChecked || event.dataCheckedAt === null) return false;
  return decideLiveLifecycle(
    event,
    fixtures.map((fixture) => ({
      started: fixture.started === true,
      finished: fixture.finished,
      finishedProvisional: fixture.finished_provisional,
      kickoffTime: fixture.kickoff_time === null ? null : new Date(fixture.kickoff_time),
    })),
  ).finalizeEvent;
}

export function canSkipMissingDetailDuringSeed(
  result: Pick<LiveSnapshotV2SyncResult, 'fixtureCount' | 'state'>,
  matchState: MatchLifecycleState | null = null,
  currentMatchSyncSucceeded = false,
): boolean {
  return (
    result.fixtureCount === 0 ||
    result.state === 'PRE_DEADLINE' ||
    (matchState === 'BETWEEN_FIXTURES' && currentMatchSyncSucceeded)
  );
}

type MatchDeskSyncRead = Pick<MatchDeskRead, 'servedFrom'> & {
  readonly publication: Pick<
    MatchDeskRead['publication'],
    'publicationId' | 'generation' | 'sourceCheckedAt'
  >;
};

/**
 * A pre-existing BETWEEN_FIXTURES pointer is not evidence that this seed
 * observed the current provider state. A newly published or touched current
 * pointer is the minimum proof that the sibling Match sync ran successfully.
 */
export function hasCurrentMatchDeskSyncEvidence(
  before: MatchDeskSyncRead | null,
  after: MatchDeskSyncRead | null,
): boolean {
  if (!after || after.servedFrom !== 'REDIS_CURRENT') return false;
  if (!before) return true;
  return (
    before.publication.publicationId !== after.publication.publicationId ||
    before.publication.generation !== after.publication.generation ||
    before.publication.sourceCheckedAt !== after.publication.sourceCheckedAt
  );
}

async function seedOne(seasonCode: string, eventId: number) {
  const season = explicitSeasonRef(seasonCode);
  const event = await eventRepository.findById(season, eventId);
  if (!event) throw new Error(`event ${eventId} does not exist in season ${seasonCode}`);

  const [durableDesk, durableDetail] = await Promise.all([
    readLiveMatchDeskCheckpointV3(season, eventId),
    readLiveMatchDetailCheckpointV3(season, eventId),
  ]);
  const reusable = reusableFinalLiveMatchSeed(durableDesk, durableDetail);
  if (reusable) {
    return {
      season: seasonCode,
      eventId,
      ...reusable,
      checkpointed: true,
    } as const;
  }

  const deskBefore = await readLiveMatchDeskPointerV3({ season: seasonCode, eventId }, 'active');

  // This is the deployment-only fixtures observation used by both the
  // finalization fence and syncLiveSnapshotV2. Passing the exact response into
  // sync prevents a second provider read from changing the facts underneath
  // the immutable FINAL decision.
  const observedFixtures = await fplClient.getFixtures(eventId);
  const finalized = canFinalizeLiveMatchSeed(event, observedFixtures);
  const result = await syncLiveSnapshotV2(season, eventId, {
    observedFixtures,
    trigger: 'catchup',
    finalizeEvent: finalized,
    lifecycleState: finalized ? 'FINALIZED' : undefined,
  });

  const desk = await readLiveMatchDeskPointerV3({ season: seasonCode, eventId }, 'active');
  let deskCheckpoint: Awaited<ReturnType<typeof readLiveMatchDeskCheckpointV3>> = null;
  if (desk?.servedFrom === 'REDIS_CURRENT') {
    // Desk is independently authoritative. Checkpoint it even when the
    // event has no price-bearing detail, so the desk still needs its own
    // exact V3 checkpoint before the maintenance window can finish.
    const existingDeskDesired = await readLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      season: seasonCode,
      eventId,
    });
    const desired = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: desk.publication,
      finalized: desk.publication.state === 'FINALIZED',
      force: true,
      replaceFinalizedForCutover:
        existingDeskDesired?.final === true && desk.publication.state === 'FINALIZED'
          ? {
              expectedPublicationId: existingDeskDesired.publicationId,
              expectedGeneration: existingDeskDesired.generation,
            }
          : undefined,
    });
    if (
      desired.publicationId !== desk.publication.publicationId ||
      desired.generation !== desk.publication.generation
    ) {
      throw new Error(`event ${eventId} desk checkpoint obligation was superseded during seed`);
    }
    const checkpoint = await checkpointLiveMatchScopeV3({
      season,
      eventId,
      kind: 'desk',
    });
    if (!checkpoint.checkpointed) {
      throw new Error(`event ${eventId} desk checkpoint did not converge`);
    }
    deskCheckpoint = await readLiveMatchDeskCheckpointV3(season, eventId);
    if (
      !deskCheckpoint ||
      deskCheckpoint.publication.publicationId !== desk.publication.publicationId ||
      deskCheckpoint.publication.generation !== desk.publication.generation
    ) {
      throw new Error(`event ${eventId} desk checkpoint is not the matching V3 publication`);
    }
  }
  const active = await readLiveMatchDetailPointerV3({ season: seasonCode, eventId }, 'active');
  if (!active) {
    // A blank gameweek, a genuinely pre-deadline event, or a settled gap
    // between fixtures has no price-bearing detail that this cutover needs to
    // make durable. The desk is still published and remains independently
    // readable. Once the coherent observer says the event is active or in
    // final settling, missing detail is a failed cutover prerequisite rather
    // than a successful no-op.
    if (
      canSkipMissingDetailDuringSeed(
        result,
        desk?.publication.state ?? null,
        hasCurrentMatchDeskSyncEvidence(deskBefore, desk),
      )
    ) {
      return {
        season: seasonCode,
        eventId,
        status: 'no-player-detail',
        generation: deskCheckpoint?.publication.generation ?? null,
        checkpointed: deskCheckpoint !== null,
      } as const;
    }
    throw new Error(`event ${eventId} did not produce a V3 detail publication`);
  }
  const detail = active.fixtures;
  if (!hasCanonicalPrices(detail)) {
    throw new Error(`event ${eventId} detail publication is missing canonical player prices`);
  }

  if (!desk || desk.servedFrom !== 'REDIS_CURRENT') {
    throw new Error(`event ${eventId} does not have a current V3 desk publication`);
  }
  if (
    active.publication.observedDeskGeneration !== desk.publication.generation ||
    active.publication.fixtureIdentityRevision !==
      desk.publication.revisions.fixtureIdentity.revision
  ) {
    throw new Error(`event ${eventId} detail is not aligned with the current V3 desk publication`);
  }

  if (!deskCheckpoint) throw new Error(`event ${eventId} desk checkpoint is missing before detail`);

  // Force one exact durable write for this cutover publication. This is a
  // source-backed seed, not a legacy reader: the new runtime only accepts the
  // price-bearing publication after this checkpoint succeeds.
  const existingDetailDesired = await readLiveMatchCheckpointDesiredV3({
    kind: 'detail',
    season: seasonCode,
    eventId,
  });
  const detailDesired = await setLiveMatchCheckpointDesiredV3({
    kind: 'detail',
    publication: active.publication,
    finalized: active.publication.finalized,
    force: true,
    replaceFinalizedForCutover:
      existingDetailDesired?.final === true && active.publication.finalized === true
        ? {
            expectedPublicationId: existingDetailDesired.publicationId,
            expectedGeneration: existingDetailDesired.generation,
          }
        : undefined,
  });
  if (
    detailDesired.publicationId !== active.publication.publicationId ||
    detailDesired.generation !== active.publication.generation
  ) {
    throw new Error(`event ${eventId} detail checkpoint obligation was superseded during seed`);
  }
  const checkpoint = await checkpointLiveMatchScopeV3({
    season,
    eventId,
    kind: 'detail',
  });
  if (!checkpoint.checkpointed) {
    throw new Error(`event ${eventId} detail checkpoint did not converge`);
  }
  const durable = await readLiveMatchDetailCheckpointV3(season, eventId);
  if (
    !durable ||
    durable.publication.publicationId !== active.publication.publicationId ||
    durable.publication.generation !== active.publication.generation ||
    !hasCanonicalPrices(durable.fixtures)
  ) {
    throw new Error(`event ${eventId} detail checkpoint is not the seeded V3 publication`);
  }
  return {
    season: seasonCode,
    eventId,
    status: 'seeded',
    generation: active.publication.generation,
    checkpointed: true,
  } as const;
}

async function main(): Promise<void> {
  const args = parseLiveMatchSeedArguments(process.argv.slice(2));
  if (args.season === null) throw new Error('live-match V3 cutover seed requires --season');

  const season = await seasonRepository.requireByCode(args.season);
  const eventIds = new Set<number>();
  if (args.eventId !== null) eventIds.add(args.eventId);
  if (args.allFinalized) {
    for (const event of await eventRepository.findAll(season)) {
      if (event.finished && event.dataChecked && event.dataCheckedAt !== null) {
        eventIds.add(event.id);
      }
    }
  }

  const results = [];
  for (const eventId of [...eventIds].sort((left, right) => left - right)) {
    results.push(await seedOne(args.season, eventId));
  }
  console.log(
    JSON.stringify(
      {
        operation: 'seed-live-matches-v3',
        season: args.season,
        allFinalized: args.allFinalized,
        results,
      },
      null,
      2,
    ),
  );
}

async function closeSeedResources(): Promise<void> {
  let cleanupTimedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cleanup = Promise.allSettled([
    closeLiveDataQueue(),
    redisSingleton.disconnect(),
    databaseSingleton.disconnect(),
  ]);
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          cleanupTimedOut = true;
          resolve();
        }, SEED_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
  if (cleanupTimedOut) {
    console.error(
      `[seed-live-matches-v3] cleanup exceeded ${SEED_CLEANUP_TIMEOUT_MS}ms; forcing one-shot exit`,
    );
  }
}

if (import.meta.main) {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error('[seed-live-matches-v3] failed', error);
    exitCode = 1;
  }
  // This one-shot cutover command must not leave provider/database/queue
  // handles alive after reporting either success or failure. A bounded cleanup
  // prevents an individual client close from holding the deploy in maintenance
  // mode until its external timeout kills the container.
  await closeSeedResources();
  process.exit(exitCode);
}
