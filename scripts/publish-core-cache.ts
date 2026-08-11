/* eslint-disable no-console */
import { and, eq, isNull } from 'drizzle-orm';

import { publishCoreSnapshotCache, readCoreSnapshotCache } from '../src/cache/core-snapshot-cache';
import { redisSingleton } from '../src/cache/singleton';
import { datasetPublicationsInOps, seasonsInFpl } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb, getDbClient } from '../src/db/singleton';
import { assertDataRuntimeRole } from '../src/db/runtime-role-contract';
import { eventRepository } from '../src/repositories/events';
import { fixtureRepository } from '../src/repositories/fixtures';
import { phaseRepository } from '../src/repositories/phases';
import { playerRepository } from '../src/repositories/players';
import { seasonRepository } from '../src/repositories/seasons';
import { syncOperationsRepository } from '../src/repositories/sync-operations';
import { teamRepository } from '../src/repositories/teams';
import { getConfig } from '../src/utils/config';

type CoreCounts = {
  readonly events: number;
  readonly teams: number;
  readonly players: number;
  readonly phases: number;
  readonly fixtures: number;
};

function assertArguments(args: readonly string[]): { execute: boolean; allowEmpty: boolean } {
  const unknown = args.find((argument) => argument !== '--execute' && argument !== '--allow-empty');
  if (unknown) throw new Error(`Unknown core-cache argument: ${unknown}`);
  if (args.filter((argument) => argument === '--execute').length > 1) {
    throw new Error('--execute must not be repeated');
  }
  if (args.filter((argument) => argument === '--allow-empty').length > 1) {
    throw new Error('--allow-empty must not be repeated');
  }
  const execute = args.includes('--execute');
  const allowEmpty = args.includes('--allow-empty');
  if (allowEmpty && !execute) throw new Error('--allow-empty requires --execute');
  return { execute, allowEmpty };
}

function assertCoreCounts(counts: CoreCounts): void {
  if (counts.events !== 38 || counts.teams !== 20 || counts.fixtures !== 380) {
    throw new Error('Current core snapshot does not have the exact 38/20/380 season shape');
  }
  if (counts.players < 220 || counts.phases < 1) {
    throw new Error('Current core snapshot player/phase coverage is incomplete');
  }
}

async function main(): Promise<void> {
  const { execute, allowEmpty } = assertArguments(process.argv.slice(2));
  const config = getConfig();
  const db = await getDb();
  await assertDataRuntimeRole(await getDbClient());
  const [existingSeason] = await db
    .select({ seasonId: seasonsInFpl.seasonId })
    .from(seasonsInFpl)
    .limit(1);
  if (!existingSeason && allowEmpty) {
    console.log(
      JSON.stringify(
        {
          operation: 'publish-core-cache',
          executed: false,
          skipped: 'empty_database_baseline',
          cacheDatabase: config.CACHE_REDIS_DB,
        },
        null,
        2,
      ),
    );
    return;
  }
  const season = await seasonRepository.findCurrent();
  const publicationRows = await db
    .select({
      publicationId: datasetPublicationsInOps.publicationId,
      revision: datasetPublicationsInOps.revision,
      activatedAt: datasetPublicationsInOps.activatedAt,
    })
    .from(datasetPublicationsInOps)
    .where(
      and(
        eq(datasetPublicationsInOps.dataset, 'fpl:core'),
        eq(datasetPublicationsInOps.seasonId, season.seasonId),
        isNull(datasetPublicationsInOps.eventId),
        eq(datasetPublicationsInOps.status, 'active'),
      ),
    )
    .limit(2);
  const publication = publicationRows[0];
  if (publicationRows.length !== 1 || !publication?.activatedAt) {
    throw new Error('Exactly one activated current-season core database publication is required');
  }

  const [events, teams, players, phases, fixtures] = await Promise.all([
    eventRepository.findAll(season),
    teamRepository.findAll(season),
    playerRepository.findAll(season),
    phaseRepository.findAll(season),
    fixtureRepository.findAll(season),
  ]);
  const counts: CoreCounts = {
    events: events.length,
    teams: teams.length,
    players: players.length,
    phases: phases.length,
    fixtures: fixtures.length,
  };
  assertCoreCounts(counts);

  const preflight = {
    operation: 'publish-core-cache',
    executed: false,
    seasonCode: season.seasonCode,
    publicationId: publication.publicationId,
    revision: publication.revision,
    sourceCheckedAt: publication.activatedAt.toISOString(),
    cacheDatabase: config.CACHE_REDIS_DB,
    counts,
  } as const;
  if (!execute) {
    console.log(JSON.stringify(preflight, null, 2));
    return;
  }

  const result = await publishCoreSnapshotCache(
    {
      season: season.seasonCode,
      events,
      teams,
      players,
      phases,
      fixtures,
    },
    {
      revision: publication.revision,
      publicationId: publication.publicationId,
      sourceCheckedAt: publication.activatedAt,
      beforeActivate: async () => {
        const [currentSeason, active] = await Promise.all([
          seasonRepository.findCurrent(),
          syncOperationsRepository.findActivePublication('fpl:core', season),
        ]);
        return (
          currentSeason.seasonId === season.seasonId &&
          active?.publicationId === publication.publicationId &&
          active.revision === publication.revision
        );
      },
    },
  );
  if (!result.published) {
    throw new Error('A newer core cache publication owns the current-season scope');
  }

  const verified = await readCoreSnapshotCache(season.seasonCode);
  if (
    !verified ||
    verified.manifest.publicationId !== publication.publicationId ||
    verified.manifest.revision !== publication.revision ||
    verified.events.length !== counts.events ||
    verified.teams.length !== counts.teams ||
    verified.players.length !== counts.players ||
    verified.phases.length !== counts.phases ||
    verified.fixtures.length !== counts.fixtures
  ) {
    throw new Error('Published core cache failed its exact read-back verification');
  }

  const persistedManifest = await db
    .update(datasetPublicationsInOps)
    .set({ manifest: verified.manifest, updatedAt: new Date() })
    .where(
      and(
        eq(datasetPublicationsInOps.publicationId, publication.publicationId),
        eq(datasetPublicationsInOps.status, 'active'),
        eq(datasetPublicationsInOps.dataset, 'fpl:core'),
        eq(datasetPublicationsInOps.seasonId, season.seasonId),
        isNull(datasetPublicationsInOps.eventId),
      ),
    )
    .returning({ publicationId: datasetPublicationsInOps.publicationId });
  if (persistedManifest.length !== 1) {
    throw new Error('Canonical core manifest could not be persisted to PostgreSQL');
  }

  console.log(
    JSON.stringify(
      {
        ...preflight,
        executed: true,
        published: true,
        currentEventId: verified.currentEventId,
        items: verified.manifest.items,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('[publish-core-cache] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  });
