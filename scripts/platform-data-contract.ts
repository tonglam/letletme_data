import { createHash } from 'node:crypto';

import postgres from 'postgres';

import { PLATFORM_SCHEMAS } from './platform-schema-contract';

type QueryClient = postgres.Sql | postgres.TransactionSql;

type RelationIdentity = {
  schema_name: string;
  relation_name: string;
  relation_kind: 'm' | 'p' | 'r';
};

export type RelationDataDigest = {
  relation: string;
  kind: RelationIdentity['relation_kind'];
  rowCount: string;
  contentHash: string;
};

export type SequenceState = {
  sequence: string;
  lastValue: string;
  isCalled: boolean;
};

export type PlatformDataManifest = {
  relations: RelationDataDigest[];
  sequences: SequenceState[];
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function loadPlatformDataManifest(client: QueryClient): Promise<PlatformDataManifest> {
  const identities = await client<RelationIdentity[]>`
    SELECT
      namespace_row.nspname AS schema_name,
      relation_row.relname AS relation_name,
      relation_row.relkind AS relation_kind
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = ANY (${PLATFORM_SCHEMAS as unknown as string[]})
      AND relation_row.relkind IN ('r', 'p', 'm')
      AND NOT (
        namespace_row.nspname = 'ops'
        AND relation_row.relname = 'schema_migrations'
      )
    ORDER BY namespace_row.nspname, relation_row.relname
  `;

  const relations: RelationDataDigest[] = [];
  for (const identity of identities) {
    const qualifiedName = `${quoteIdentifier(identity.schema_name)}.${quoteIdentifier(
      identity.relation_name,
    )}`;
    const [digest] = await client.unsafe<{ row_count: string; content_hash: string }[]>(`
      SELECT
        count(*)::text AS row_count,
        md5(COALESCE(string_agg(row_hash, '' ORDER BY row_hash), '')) AS content_hash
      FROM (
        SELECT md5(to_jsonb(source_row)::text) AS row_hash
        FROM ${qualifiedName} source_row
      ) hashed_rows
    `);
    if (!digest)
      throw new Error(`Failed to hash ${identity.schema_name}.${identity.relation_name}`);
    relations.push({
      relation: `${identity.schema_name}.${identity.relation_name}`,
      kind: identity.relation_kind,
      rowCount: digest.row_count,
      contentHash: digest.content_hash,
    });
  }

  const sequenceIdentities = await client<{ schema_name: string; sequence_name: string }[]>`
    SELECT schemaname AS schema_name, sequencename AS sequence_name
    FROM pg_sequences
    WHERE schemaname = ANY (${PLATFORM_SCHEMAS as unknown as string[]})
    ORDER BY schemaname, sequencename
  `;
  const sequences: SequenceState[] = [];
  for (const identity of sequenceIdentities) {
    const qualifiedName = `${quoteIdentifier(identity.schema_name)}.${quoteIdentifier(
      identity.sequence_name,
    )}`;
    const [state] = await client.unsafe<{ last_value: string; is_called: boolean }[]>(`
      SELECT last_value::text, is_called FROM ${qualifiedName}
    `);
    if (!state) throw new Error(`Failed to read sequence ${qualifiedName}`);
    sequences.push({
      sequence: `${identity.schema_name}.${identity.sequence_name}`,
      lastValue: state.last_value,
      isCalled: state.is_called,
    });
  }

  return { relations, sequences };
}

export function serializePlatformDataManifest(manifest: PlatformDataManifest): string {
  return JSON.stringify({
    relations: [...manifest.relations].sort((left, right) =>
      left.relation.localeCompare(right.relation),
    ),
    sequences: [...manifest.sequences].sort((left, right) =>
      left.sequence.localeCompare(right.sequence),
    ),
  });
}

export function fingerprintPlatformDataManifest(manifest: PlatformDataManifest): string {
  return createHash('sha256').update(serializePlatformDataManifest(manifest), 'utf8').digest('hex');
}
