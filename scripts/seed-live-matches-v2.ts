/* eslint-disable no-console */

import { explicitSeasonRef } from '../src/domain/fpl-season';
import { eventRepository } from '../src/repositories/events';
import { seasonRepository } from '../src/repositories/seasons';
import {
  readLiveMatchDetailCheckpointV2,
  checkpointLiveMatchScopeV2,
} from '../src/services/live-match-v2-checkpoint.service';
import {
  readLiveMatchDetailPointerV2,
  setLiveMatchCheckpointDesiredV2,
} from '../src/cache/live-match-publication-v2';
import { syncLiveSnapshotV2 } from '../src/services/live-snapshot-v2.service';
import { databaseSingleton } from '../src/db/singleton';
import { redisSingleton } from '../src/cache/singleton';

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
    fixture.players.every((player) => Number.isSafeInteger(player.price) && player.price >= 0),
  );
}

async function seedOne(seasonCode: string, eventId: number) {
  const season = explicitSeasonRef(seasonCode);
  const event = await eventRepository.findById(season, eventId);
  if (!event) throw new Error(`event ${eventId} does not exist in season ${seasonCode}`);

  const finalized = event.finished && event.dataChecked && event.dataCheckedAt !== null;
  const result = await syncLiveSnapshotV2(season, eventId, {
    trigger: 'catchup',
    finalizeEvent: finalized,
    lifecycleState: finalized ? 'FINALIZED' : undefined,
  });

  const active = await readLiveMatchDetailPointerV2({ season: seasonCode, eventId }, 'active');
  if (!active) {
    // Before kickoff the match detail stream is intentionally absent. There
    // is no player payload to migrate; the first started observation will
    // publish the price-bearing V2 detail atomically.
    if (result.fixtureCount === 0 || !finalized) {
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

  // Force one exact durable write for this cutover publication. This is a
  // source-backed seed, not a legacy reader: the new runtime only accepts the
  // price-bearing publication after this checkpoint succeeds.
  await setLiveMatchCheckpointDesiredV2({
    kind: 'detail',
    publication: active.publication,
    finalized: active.publication.finalized,
    force: true,
  });
  const checkpoint = await checkpointLiveMatchScopeV2({
    season,
    eventId,
    kind: 'detail',
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
