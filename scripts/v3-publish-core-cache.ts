/* eslint-disable no-console */
import { and, eq, isNull } from 'drizzle-orm';

import {
  DATA_PLATFORM_PLAN_VERSION,
  DATA_PUBLICATION_SCHEMA_VERSION,
} from '../src/cache/data-publication';
import { publishCoreSnapshotCache, readCoreSnapshotCache } from '../src/cache/core-snapshot-cache';
import { redisSingleton } from '../src/cache/singleton';
import { datasetPublicationsInOps, migrationRunsInOps } from '../src/db/schemas/index.schema';
import { databaseSingleton, getDb, getDbClient } from '../src/db/singleton';
import { eventRepository } from '../src/repositories/events';
import { fixtureRepository } from '../src/repositories/fixtures';
import { phaseRepository } from '../src/repositories/phases';
import { playerRepository } from '../src/repositories/players';
import { seasonRepository } from '../src/repositories/seasons';
import { syncOperationsRepository } from '../src/repositories/sync-operations';
import { teamRepository } from '../src/repositories/teams';
import { getConfig } from '../src/utils/config';
import { assertExactV3CoreCacheApproval } from './v3-core-cache-gate';

type PublicationManifest = {
  readonly schemaVersion?: unknown;
  readonly planVersion?: unknown;
  readonly counts?: unknown;
};

type CoreCounts = {
  readonly events: number;
  readonly teams: number;
  readonly players: number;
  readonly phases: number;
  readonly fixtures: number;
};

function assertArguments(args: readonly string[]): boolean {
  const unknown = args.find((argument) => argument !== '--execute');
  if (unknown) throw new Error(`Unknown core-cache argument: ${unknown}`);
  if (args.filter((argument) => argument === '--execute').length > 1) {
    throw new Error('--execute must not be repeated');
  }
  return args.includes('--execute');
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key)
  );
}

function manifestCount(manifest: PublicationManifest, key: string): number | null {
  if (typeof manifest.counts !== 'object' || manifest.counts === null) return null;
  const value = (manifest.counts as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertCoreCounts(manifest: PublicationManifest, counts: CoreCounts): void {
  if (counts.events !== 38 || counts.teams !== 20 || counts.fixtures !== 380) {
    throw new Error('Current core snapshot does not have the exact 38/20/380 season shape');
  }
  if (counts.players < 220 || counts.phases < 1) {
    throw new Error('Current core snapshot player/phase coverage is incomplete');
  }
  for (const key of ['events', 'teams', 'players', 'fixtures'] as const) {
    if (manifestCount(manifest, key) !== counts[key]) {
      throw new Error(`Active database publication count differs for ${key}`);
    }
  }
}

async function assertDataRuntimeLogin(): Promise<void> {
  const client = await getDbClient();
  const roles = await client<
    Array<{
      role_name: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>
  >`
    SELECT
      rolname AS role_name,
      rolcanlogin,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolinherit,
      rolreplication,
      rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `;
  const role = roles[0];
  if (
    roles.length !== 1 ||
    !role?.rolcanlogin ||
    !role.rolinherit ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolbypassrls
  ) {
    throw new Error('Core cache publication requires a dedicated non-admin Data runtime LOGIN');
  }

  const memberships = await client<Array<{ role_name: string }>>`
    SELECT granted_role.rolname AS role_name
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE member_role.rolname = current_user
    ORDER BY granted_role.rolname
  `;
  if (memberships.length !== 1 || memberships[0]?.role_name !== 'letletme_data_owner') {
    throw new Error('Core cache publication LOGIN must inherit only letletme_data_owner');
  }
}

async function main(): Promise<void> {
  const execute = assertArguments(process.argv.slice(2));
  const runId = process.env.CUTOVER_RUN_ID?.trim();
  if (!runId) throw new Error('CUTOVER_RUN_ID is required');

  const config = getConfig();
  const db = await getDb();
  await assertDataRuntimeLogin();
  const season = await seasonRepository.findCurrent();
  const migrationRows = await db
    .select({
      status: migrationRunsInOps.status,
      metadata: migrationRunsInOps.metadata,
    })
    .from(migrationRunsInOps)
    .where(eq(migrationRunsInOps.runId, runId))
    .limit(2);
  const migration = migrationRows[0];
  if (
    migrationRows.length !== 1 ||
    migration?.status !== 'activated' ||
    hasOwn(migration.metadata, 'legacyDropPhase')
  ) {
    throw new Error('Core cache publication requires the exact activated pre-cleanup run');
  }

  const publicationRows = await db
    .select({
      publicationId: datasetPublicationsInOps.publicationId,
      revision: datasetPublicationsInOps.revision,
      manifest: datasetPublicationsInOps.manifest,
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

  const manifest = publication.manifest as PublicationManifest;
  if (
    manifest.schemaVersion !== DATA_PUBLICATION_SCHEMA_VERSION ||
    manifest.planVersion !== DATA_PLATFORM_PLAN_VERSION
  ) {
    throw new Error('Active database publication is not the accepted v3 plan contract');
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
  assertCoreCounts(manifest, counts);

  const preflight = {
    operation: 'publish-core-cache',
    executed: false,
    runId,
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

  assertExactV3CoreCacheApproval(process.env.V3_CORE_CACHE_APPROVAL, runId);
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
    console.error('[v3-publish-core-cache] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  });
