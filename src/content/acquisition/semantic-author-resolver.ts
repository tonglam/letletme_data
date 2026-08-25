import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { contentSourceEndpoints, contentSources } from '../../db/schemas/content.schema';
import { getDb, type DbHandle, type TransactionHandle } from '../../db/singleton';
import { sha256CanonicalJson } from './canonicalization';
import type { GrokBuildXPostV1 } from './grok-build-executor';
import type { ResolvedSemanticXAuthor } from './x-post-adapter';

const DISCOVERY_SCHEMA_REVISION = sha256CanonicalJson({
  kind: 'briefing-semantic-discovered-x-author',
  revision: 1,
});

type EndpointMatch = Readonly<{
  endpointId: string;
  endpointKey: string;
  sourceId: string;
  sourceKey: string;
  sourceOrigin: string;
  sourceHandle: string | null;
  locator: unknown;
  stableExternalId: string | null;
}>;

function normalizedHandle(handle: string): string {
  return handle.toLowerCase();
}

function discoveredKeys(handle: string): { sourceKey: string; endpointKey: string } {
  const suffix = sha256CanonicalJson({ platform: 'X', handle: normalizedHandle(handle) });
  const sourceKey = `observed-x-${suffix}`;
  return { sourceKey, endpointKey: `${sourceKey}-x` };
}

function locatorHandle(locator: unknown): string | null {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return null;
  const value = (locator as Record<string, unknown>).handle;
  return typeof value === 'string' ? value : null;
}

async function findHandleMatches(
  tx: TransactionHandle,
  handle: string,
): Promise<readonly EndpointMatch[]> {
  return tx
    .select({
      endpointId: contentSourceEndpoints.endpointId,
      endpointKey: contentSourceEndpoints.endpointKey,
      sourceId: contentSources.sourceId,
      sourceKey: contentSources.sourceKey,
      sourceOrigin: contentSources.origin,
      sourceHandle: contentSources.handle,
      locator: contentSourceEndpoints.locator,
      stableExternalId: contentSourceEndpoints.stableExternalId,
    })
    .from(contentSourceEndpoints)
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
    .where(
      and(
        eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'),
        sql`lower(${contentSourceEndpoints.locator}->>'handle') = ${normalizedHandle(handle)}`,
      ),
    )
    .for('update');
}

function resolved(match: EndpointMatch, requestedHandle: string): ResolvedSemanticXAuthor {
  const endpointHandle = locatorHandle(match.locator);
  if (!endpointHandle || normalizedHandle(endpointHandle) !== normalizedHandle(requestedHandle)) {
    throw new Error('Resolved semantic author endpoint has a mismatched handle');
  }
  return {
    authorHandle: endpointHandle,
    endpointKey: match.endpointKey,
    stableExternalId: match.stableExternalId,
  };
}

async function resolveOne(tx: TransactionHandle, handle: string, dbNow: Date) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`briefing-semantic-author:${normalizedHandle(handle)}`}))`,
  );
  const existing = await findHandleMatches(tx, handle);
  if (existing.length > 1) {
    throw new Error(`Multiple X endpoints match semantic author @${handle}`);
  }
  if (existing[0]) return resolved(existing[0], handle);

  const keys = discoveredKeys(handle);
  await tx
    .insert(contentSources)
    .values({
      sourceId: randomUUID(),
      sourceKey: keys.sourceKey,
      platform: 'X',
      externalId: null,
      handle,
      displayName: `@${handle}`,
      sourceType: 'DISCOVERED_UNKNOWN',
      reportingFamily: 'DISCOVERED',
      status: 'observed',
      origin: 'DISCOVERED',
      manifestRevision: null,
      rightsPolicy: { mode: 'PUBLIC_POST' },
      updatedAt: dbNow,
    })
    .onConflictDoNothing({ target: contentSources.sourceKey });
  const sourceRows = await tx
    .select({
      sourceId: contentSources.sourceId,
      origin: contentSources.origin,
      handle: contentSources.handle,
    })
    .from(contentSources)
    .where(eq(contentSources.sourceKey, keys.sourceKey))
    .for('update')
    .limit(1);
  const source = sourceRows[0];
  if (
    !source ||
    source.origin !== 'DISCOVERED' ||
    !source.handle ||
    normalizedHandle(source.handle) !== normalizedHandle(handle)
  ) {
    throw new Error(`Discovered X source key collision for @${handle}`);
  }
  await tx
    .insert(contentSourceEndpoints)
    .values({
      endpointId: randomUUID(),
      endpointKey: keys.endpointKey,
      sourceId: source.sourceId,
      adapterKind: 'X_ACCOUNT',
      profileKey: 'x-observed-v1',
      locator: { handle },
      stableExternalId: null,
      identityRequirement: 'DISCOVERED_ONLY',
      identityStatus: 'PENDING',
      identityErrorSummary: null,
      identityCheckedAt: null,
      identityNextCheckAt: null,
      status: 'observed',
      origin: 'DISCOVERED',
      rightsPolicy: { mode: 'PUBLIC_POST' },
      manifestRevision: DISCOVERY_SCHEMA_REVISION,
      updatedAt: dbNow,
    })
    .onConflictDoNothing({ target: contentSourceEndpoints.endpointKey });
  const matches = await findHandleMatches(tx, handle);
  if (matches.length !== 1 || matches[0]?.sourceId !== source.sourceId) {
    throw new Error(`Discovered X endpoint identity conflict for @${handle}`);
  }
  return resolved(matches[0], handle);
}

export async function resolveSemanticXAuthors(input: {
  posts: readonly GrokBuildXPostV1[];
  db?: DbHandle;
}): Promise<readonly ResolvedSemanticXAuthor[]> {
  const handles = [...new Set(input.posts.map((post) => post.authorHandle))].sort((left, right) =>
    normalizedHandle(left).localeCompare(normalizedHandle(right)),
  );
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = new Date(clockRows[0]?.dbNow ?? Number.NaN);
    if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');
    const result: ResolvedSemanticXAuthor[] = [];
    for (const handle of handles) result.push(await resolveOne(tx, handle, dbNow));
    return result;
  });
}
