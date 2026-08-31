import { createHash } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  dataPublicationOutboxInOps,
  datasetPublicationItemsInOps,
  datasetPublicationsInOps,
  syncRunsInOps,
} from '../src/db/schemas/index.schema';
import { isDataPublicationId, parseDataPublicationManifest } from '../src/cache/data-publication';
import { isTransactionPoolerConnection } from '../src/db/postgres-connection';
import * as schema from '../src/db/schemas/index.schema';
import { canonicalJson } from '../src/utils/content-hash';

const CORE_ITEM_NAME_SETS = [
  ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId'],
  ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId', 'selectionRules'],
] as const;

type RepairAction = 'inspect' | 'retire';

export type RetireCoreStagingArguments = Readonly<{
  action: RepairAction;
  publicationId: string;
  seasonId: number;
  expectedActivePublicationId: string;
  expectedActiveRevision: number;
  reason: string | null;
}>;

type CoreStagingRow = Readonly<{
  publicationId: string;
  dataset: string;
  seasonId: number | null;
  eventId: number | null;
  revision: number;
  status: string;
  manifest: unknown;
  sourceRunId: string | null;
  expiresAt: Date | null;
}>;

function usage(): never {
  throw new Error(
    'usage: bun scripts/retire-superseded-core-staging-publication.ts --action inspect|retire --publication-id UUID --season-id N --expected-active-publication-id UUID --expected-active-revision N [--reason text]',
  );
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseRequiredUuid(value: string | undefined, flag: string): string {
  if (!isDataPublicationId(value)) throw new Error(`${flag} must be an RFC UUID`);
  return value.toLowerCase();
}

export function parseRetireCoreStagingArguments(
  argv: readonly string[],
): RetireCoreStagingArguments {
  const allowedKeys = new Set([
    'action',
    'publication-id',
    'season-id',
    'expected-active-publication-id',
    'expected-active-revision',
    'reason',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      const key = token.slice(2, separator);
      if (!allowedKeys.has(key) || values.has(key)) usage();
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!allowedKeys.has(key) || !value || value.startsWith('--') || values.has(key)) usage();
    values.set(key, value);
    index += 1;
  }

  const action = values.get('action') as RepairAction | undefined;
  if (action !== 'inspect' && action !== 'retire') usage();

  const publicationId = parseRequiredUuid(values.get('publication-id'), '--publication-id');
  const seasonId = parsePositiveInteger(values.get('season-id'), '--season-id');
  const expectedActivePublicationId = parseRequiredUuid(
    values.get('expected-active-publication-id'),
    '--expected-active-publication-id',
  );
  const expectedActiveRevision = parsePositiveInteger(
    values.get('expected-active-revision'),
    '--expected-active-revision',
  );
  const reason = values.get('reason')?.trim() || null;
  if (action === 'retire' && (!reason || reason.length < 12)) {
    throw new Error('--reason is required for retire and must contain at least 12 characters');
  }
  return {
    action,
    publicationId,
    seasonId,
    expectedActivePublicationId,
    expectedActiveRevision,
    reason,
  };
}

export function assertRetireAuthorization(
  action: RepairAction,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (action !== 'retire') return;
  if (environment.DATA_STAGING_REPAIR_CONFIRM !== 'YES') {
    throw new Error(
      'retire refused: set DATA_STAGING_REPAIR_CONFIRM=YES for this exact publication command',
    );
  }
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function serializedPayloadCandidates(payload: unknown): readonly string[] {
  return [canonicalJson(payload), JSON.stringify(payload)];
}

export function isSupportedCoreItemSet(itemNames: readonly string[]): boolean {
  const uniqueNames = [...new Set(itemNames)].sort();
  if (uniqueNames.length !== itemNames.length) return false;
  return CORE_ITEM_NAME_SETS.some((expectedNames) => {
    const sortedExpectedNames = [...expectedNames].sort();
    return (
      sortedExpectedNames.length === uniqueNames.length &&
      sortedExpectedNames.every((name, index) => name === uniqueNames[index])
    );
  });
}

type RepairDatabase = ReturnType<typeof drizzle>;
type RepairClient = ReturnType<typeof postgres>;

function createRepairDatabase(environment: NodeJS.ProcessEnv): {
  client: RepairClient;
  db: RepairDatabase;
} {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for core staging repair');
  if (isTransactionPoolerConnection(databaseUrl)) {
    throw new Error(
      'Core staging repair requires direct PostgreSQL or a session-mode pooler; transaction poolers cannot hold its row lock',
    );
  }

  const client = postgres(databaseUrl, { max: 1, prepare: true });
  return { client, db: drizzle(client, { schema }) };
}

function validateCoreManifest(
  row: CoreStagingRow,
  args: RetireCoreStagingArguments,
): NonNullable<ReturnType<typeof parseDataPublicationManifest>> {
  const manifest = parseDataPublicationManifest(JSON.stringify(row.manifest));
  if (
    !manifest ||
    manifest.dataset !== 'fpl:core' ||
    manifest.eventId !== null ||
    manifest.revision !== row.revision ||
    manifest.publicationId !== row.publicationId
  ) {
    throw new Error('target has an invalid or scope-mismatched core publication manifest');
  }
  if (row.seasonId !== args.seasonId) {
    throw new Error('target season does not match --season-id');
  }
  const manifestItemNames = manifest.items.map((item) => item.name);
  if (!isSupportedCoreItemSet(manifestItemNames)) {
    throw new Error('target manifest is not a complete six- or seven-item core publication');
  }
  return manifest;
}

async function validateTarget(
  args: RetireCoreStagingArguments,
  operation: 'inspect' | 'retire',
  db: RepairDatabase,
): Promise<{
  target: CoreStagingRow;
  active: { publicationId: string; revision: number };
  sourceRunId: string;
  sourcePublicationId: string;
  itemCount: number;
  outboxCount: number;
  retiredAt: Date | null;
}> {
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const databaseNow = clockRows[0]?.now;
    if (!isDate(databaseNow)) throw new Error('database clock is invalid');

    const targetRows = await tx
      .select({
        publicationId: datasetPublicationsInOps.publicationId,
        dataset: datasetPublicationsInOps.dataset,
        seasonId: datasetPublicationsInOps.seasonId,
        eventId: datasetPublicationsInOps.eventId,
        revision: datasetPublicationsInOps.revision,
        status: datasetPublicationsInOps.status,
        manifest: datasetPublicationsInOps.manifest,
        sourceRunId: datasetPublicationsInOps.sourceRunId,
        expiresAt: datasetPublicationsInOps.expiresAt,
      })
      .from(datasetPublicationsInOps)
      .where(eq(datasetPublicationsInOps.publicationId, args.publicationId))
      .for('update');
    const target = targetRows[0] as CoreStagingRow | undefined;
    if (!target) throw new Error('target publication does not exist');
    if (
      target.dataset !== 'fpl:core' ||
      target.seasonId !== args.seasonId ||
      target.eventId !== null ||
      target.status !== 'staging'
    ) {
      throw new Error('target is not the requested staging fpl:core season publication');
    }
    if (
      !target.sourceRunId ||
      !target.expiresAt ||
      target.expiresAt.getTime() > databaseNow.getTime()
    ) {
      throw new Error('target is not an expired staging publication');
    }

    const activeRows = await tx
      .select({
        publicationId: datasetPublicationsInOps.publicationId,
        revision: datasetPublicationsInOps.revision,
      })
      .from(datasetPublicationsInOps)
      .where(
        and(
          eq(datasetPublicationsInOps.dataset, 'fpl:core'),
          eq(datasetPublicationsInOps.seasonId, args.seasonId),
          isNull(datasetPublicationsInOps.eventId),
          eq(datasetPublicationsInOps.status, 'active'),
        ),
      )
      .for('update');
    const active = activeRows[0];
    if (
      !active ||
      active.publicationId !== args.expectedActivePublicationId ||
      active.revision !== args.expectedActiveRevision
    ) {
      throw new Error('active core publication no longer matches the expected fence');
    }
    if (target.revision >= active.revision) {
      throw new Error('target is not superseded by a newer active core publication');
    }

    const manifest = validateCoreManifest(target, args);
    const sourceRows = await tx
      .select({ status: syncRunsInOps.status, publicationId: syncRunsInOps.publicationId })
      .from(syncRunsInOps)
      .where(eq(syncRunsInOps.runId, target.sourceRunId))
      .limit(1);
    const sourceRun = sourceRows[0];
    const sourcePublication = sourceRun?.publicationId
      ? (
          await tx
            .select({
              publicationId: datasetPublicationsInOps.publicationId,
              dataset: datasetPublicationsInOps.dataset,
              seasonId: datasetPublicationsInOps.seasonId,
              eventId: datasetPublicationsInOps.eventId,
              revision: datasetPublicationsInOps.revision,
              status: datasetPublicationsInOps.status,
              sourceRunId: datasetPublicationsInOps.sourceRunId,
            })
            .from(datasetPublicationsInOps)
            .where(eq(datasetPublicationsInOps.publicationId, sourceRun.publicationId))
            .limit(1)
            .for('update')
        )[0]
      : undefined;
    if (
      sourceRun?.status !== 'published' ||
      !sourcePublication ||
      sourcePublication.dataset !== 'fpl:core' ||
      sourcePublication.seasonId !== args.seasonId ||
      sourcePublication.eventId !== null ||
      sourcePublication.status !== 'retired' ||
      sourcePublication.sourceRunId !== target.sourceRunId ||
      sourcePublication.revision >= active.revision
    ) {
      throw new Error(
        'target source run is not a terminal published run for a superseded same-scope core publication',
      );
    }

    const itemRows = await tx
      .select({
        itemName: datasetPublicationItemsInOps.itemName,
        payload: datasetPublicationItemsInOps.payload,
        itemCount: datasetPublicationItemsInOps.itemCount,
        checksum: datasetPublicationItemsInOps.checksum,
      })
      .from(datasetPublicationItemsInOps)
      .where(eq(datasetPublicationItemsInOps.publicationId, target.publicationId));
    if (itemRows.length !== manifest.items.length) {
      throw new Error(
        `target does not contain exactly ${manifest.items.length} immutable core items`,
      );
    }
    for (const itemManifest of manifest.items) {
      const item = itemRows.find((candidate) => candidate.itemName === itemManifest.name);
      if (!item) throw new Error(`target is missing core item ${itemManifest.name}`);
      const valid = serializedPayloadCandidates(item.payload).some(
        (serialized) =>
          Buffer.byteLength(serialized, 'utf8') === itemManifest.bytes &&
          sha256(serialized) === itemManifest.sha256 &&
          item.checksum === itemManifest.sha256 &&
          item.itemCount === itemManifest.count,
      );
      if (!valid) throw new Error(`target has invalid proof for core item ${itemManifest.name}`);
    }

    const outboxRows = await tx
      .select({ outboxId: dataPublicationOutboxInOps.outboxId })
      .from(dataPublicationOutboxInOps)
      .where(eq(dataPublicationOutboxInOps.publicationId, target.publicationId));
    if (outboxRows.length !== 0) {
      throw new Error('target has a durable outbox receipt and must be reconciled, not retired');
    }

    let retiredAt: Date | null = null;
    if (operation === 'retire') {
      const retired = await tx
        .update(datasetPublicationsInOps)
        .set({
          status: 'retired',
          retiredAt: databaseNow,
          expiresAt: new Date(databaseNow.getTime() + 15 * 60_000),
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(datasetPublicationsInOps.publicationId, target.publicationId),
            eq(datasetPublicationsInOps.status, 'staging'),
          ),
        )
        .returning({ retiredAt: datasetPublicationsInOps.retiredAt });
      retiredAt = retired[0]?.retiredAt ?? null;
      if (!retiredAt) throw new Error('target was changed before it could be retired');
    }

    return {
      target,
      active,
      sourceRunId: target.sourceRunId,
      sourcePublicationId: sourcePublication.publicationId,
      itemCount: itemRows.length,
      outboxCount: outboxRows.length,
      retiredAt,
    };
  });
}

export async function runRetireCoreStagingPublication(
  args: RetireCoreStagingArguments,
  environment: NodeJS.ProcessEnv = process.env,
) {
  assertRetireAuthorization(args.action, environment);
  const { client, db } = createRepairDatabase(environment);
  try {
    const result = await validateTarget(args, args.action, db);
    return {
      contractVersion: 'data-repair-v2',
      action: args.action,
      dataset: 'fpl:core',
      seasonId: args.seasonId,
      publicationId: result.target.publicationId,
      sourceRunId: result.sourceRunId,
      sourcePublicationId: result.sourcePublicationId,
      targetRevision: result.target.revision,
      expectedActivePublicationId: result.active.publicationId,
      expectedActiveRevision: result.active.revision,
      itemCount: result.itemCount,
      outboxCount: result.outboxCount,
      expiredAt: result.target.expiresAt?.toISOString() ?? null,
      retiredAt: result.retiredAt?.toISOString() ?? null,
      reason: args.reason,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = parseRetireCoreStagingArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(await runRetireCoreStagingPublication(args), null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
