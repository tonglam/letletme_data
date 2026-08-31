/* eslint-disable no-console */

import { fplClient } from '../src/clients/fpl';
import { explicitSeasonRef } from '../src/domain/fpl-season';
import { isCanonicalPlayerPrice } from '../src/domain/players';
import { eventRepository } from '../src/repositories/events';
import { seasonRepository } from '../src/repositories/seasons';
import {
  readLiveMatchDeskCheckpointV2,
  readLiveMatchDetailCheckpointV2,
  checkpointLiveMatchScopeV2,
} from '../src/services/live-match-v2-checkpoint.service';
import {
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchDeskPointerV2,
  readLiveMatchDetailPointerV2,
  setLiveMatchCheckpointDesiredV2,
} from '../src/cache/live-match-publication-v2';
import { decideLiveLifecycle } from '../src/services/live-lifecycle-orchestrator';
import {
  syncLiveSnapshotV2,
  type LiveSnapshotV2SyncResult,
} from '../src/services/live-snapshot-v2.service';
import { databaseSingleton } from '../src/db/singleton';
import { redisSingleton } from '../src/cache/singleton';
import type { Event, RawFPLFixture } from '../src/types';

export type LiveMatchSeedArguments = {
  readonly execute: boolean;
  readonly allFinalized: boolean;
  readonly season: string | null;
  readonly eventId: number | null;
};

function usage(): never {
  throw new Error(
    'usage: bun scripts/seed-live-matches-v2.ts --execute --season YYYY [--event-id N] [--all-finalized]',
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
): boolean {
  return result.fixtureCount === 0 || result.state === 'PRE_DEADLINE';
}

async function seedOne(seasonCode: string, eventId: number) {
  const season = explicitSeasonRef(seasonCode);
  const event = await eventRepository.findById(season, eventId);
  if (!event) throw new Error(`event ${eventId} does not exist in season ${seasonCode}`);

  // This is a deployment-only source fence. syncLiveSnapshotV2 performs the
  // coherent observation itself; this small preflight decides whether that
  // observation may request the immutable FINAL path without trusting only
  // event-level flags.
  const observedFixtures = await fplClient.getFixtures(eventId);
  const finalized = canFinalizeLiveMatchSeed(event, observedFixtures);
  const result = await syncLiveSnapshotV2(season, eventId, {
    trigger: 'catchup',
    finalizeEvent: finalized,
    lifecycleState: finalized ? 'FINALIZED' : undefined,
  });

  const active = await readLiveMatchDetailPointerV2({ season: seasonCode, eventId }, 'active');
  if (!active) {
    // A blank gameweek or a genuinely pre-deadline event has no player payload
    // to migrate. Once the coherent observer says the event is active or
    // settling, missing detail is a failed cutover prerequisite rather than a
    // successful no-op.
    if (canSkipMissingDetailDuringSeed(result)) {
      return {
        season: seasonCode,
        eventId,
        status: 'no-player-detail',
        generation: null,
        checkpointed: false,
      } as const;
    }
    throw new Error(`event ${eventId} did not produce a V2 detail publication`);
  }
  const detail = active.fixtures;
  if (!hasCanonicalPrices(detail)) {
    throw new Error(`event ${eventId} detail publication is missing canonical player prices`);
  }

  const desk = await readLiveMatchDeskPointerV2({ season: seasonCode, eventId }, 'active');
  if (!desk || desk.servedFrom !== 'REDIS_CURRENT') {
    throw new Error(`event ${eventId} does not have a current V2 desk publication`);
  }
  if (
    active.publication.observedDeskGeneration !== desk.publication.generation ||
    active.publication.fixtureIdentityRevision !==
      desk.publication.revisions.fixtureIdentity.revision
  ) {
    throw new Error(`event ${eventId} detail is not aligned with the current V2 desk publication`);
  }

  // Detail carries the desk generation it was calculated from. Persist the
  // matching desk first so a cold read can never restore detail N alongside
  // desk N-1. Both writes remain scope-local and are verified independently.
  const deskDesired = await setLiveMatchCheckpointDesiredV2({
    kind: 'desk',
    publication: desk.publication,
    finalized: desk.publication.state === 'FINALIZED',
    force: true,
  });
  if (
    deskDesired.publicationId !== desk.publication.publicationId ||
    deskDesired.generation !== desk.publication.generation
  ) {
    throw new Error(`event ${eventId} desk checkpoint obligation was superseded during seed`);
  }
  const deskCheckpoint = await checkpointLiveMatchScopeV2({ season, eventId, kind: 'desk' });
  if (!deskCheckpoint.checkpointed) {
    throw new Error(`event ${eventId} desk checkpoint did not converge before detail`);
  }
  const durableDesk = await readLiveMatchDeskCheckpointV2(season, eventId);
  if (
    !durableDesk ||
    durableDesk.publication.publicationId !== desk.publication.publicationId ||
    durableDesk.publication.generation !== desk.publication.generation
  ) {
    throw new Error(`event ${eventId} desk checkpoint is not the matching V2 publication`);
  }

  // Force one exact durable write for this cutover publication. This is a
  // source-backed seed, not a legacy reader: the new runtime only accepts the
  // price-bearing publication after this checkpoint succeeds.
  const existingDetailDesired = await readLiveMatchCheckpointDesiredV2({
    kind: 'detail',
    season: seasonCode,
    eventId,
  });
  const detailDesired = await setLiveMatchCheckpointDesiredV2({
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
  const checkpoint = await checkpointLiveMatchScopeV2({
    season,
    eventId,
    kind: 'detail',
    allowFinalizedReplacementForCutover: active.publication.finalized === true,
  });
  if (!checkpoint.checkpointed) {
    throw new Error(`event ${eventId} detail checkpoint did not converge`);
  }
  const durable = await readLiveMatchDetailCheckpointV2(season, eventId);
  if (
    !durable ||
    durable.publication.publicationId !== active.publication.publicationId ||
    durable.publication.generation !== active.publication.generation ||
    !hasCanonicalPrices(durable.fixtures)
  ) {
    throw new Error(`event ${eventId} detail checkpoint is not the seeded V2 publication`);
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
  if (args.season === null) throw new Error('live-match V2 cutover seed requires --season');

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
        operation: 'seed-live-matches-v2',
        season: args.season,
        allFinalized: args.allFinalized,
        results,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('[seed-live-matches-v2] failed', error);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}
