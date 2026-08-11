import { createHash } from 'node:crypto';

import postgres from 'postgres';

export const PLATFORM_SCHEMAS = [
  'bridge',
  'competition',
  'fpl',
  'ops',
  'reporting',
  'understat',
] as const;

type QueryClient = postgres.Sql | postgres.TransactionSql;

export type SchemaContractRow = {
  section: string;
  identity: string;
  definition: string;
};

export type ReportingMaterializedViewState = {
  name: string;
  isPopulated: boolean;
};

const schemaContractQuery = `
WITH contract_rows AS (
  SELECT
    'schema'::text AS section,
    namespace_row.nspname::text AS identity,
    jsonb_build_object(
      'owner', pg_get_userbyid(namespace_row.nspowner),
      'acl', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'grantor', pg_get_userbyid(acl_row.grantor),
            'grantee', CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            'privilege', acl_row.privilege_type,
            'grantable', acl_row.is_grantable
          )
          ORDER BY
            pg_get_userbyid(acl_row.grantor),
            CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            acl_row.privilege_type,
            acl_row.is_grantable
        )
        FROM aclexplode(
          COALESCE(namespace_row.nspacl, acldefault('n', namespace_row.nspowner))
        ) acl_row
      ), '[]'::jsonb)
    )::text AS definition
  FROM pg_namespace namespace_row
  WHERE namespace_row.nspname = ANY ($1::text[])

  UNION ALL

  SELECT
    'role'::text,
    role_row.rolname::text,
    jsonb_build_object(
      'login', role_row.rolcanlogin,
      'superuser', role_row.rolsuper,
      'createdb', role_row.rolcreatedb,
      'createrole', role_row.rolcreaterole,
      'inherit', role_row.rolinherit,
      'replication', role_row.rolreplication,
      'bypassrls', role_row.rolbypassrls,
      'connectionLimit', role_row.rolconnlimit,
      'validUntil', role_row.rolvaliduntil
    )::text
  FROM pg_roles role_row
  WHERE role_row.rolname = ANY (
    ARRAY['letletme_data_owner', 'letletme_data_writer', 'letletme_graphql_reader']::text[]
  )

  UNION ALL

  SELECT
    'type'::text,
    namespace_row.nspname || '.' || type_row.typname,
    jsonb_build_object(
      'kind', type_row.typtype,
      'category', type_row.typcategory,
      'owner', pg_get_userbyid(type_row.typowner),
      'notNull', type_row.typnotnull,
      'default', type_row.typdefault,
      'baseType', CASE
        WHEN type_row.typbasetype = 0 THEN NULL
        ELSE format_type(type_row.typbasetype, type_row.typtypmod)
      END,
      'labels', COALESCE((
        SELECT jsonb_agg(enum_row.enumlabel ORDER BY enum_row.enumsortorder)
        FROM pg_enum enum_row
        WHERE enum_row.enumtypid = type_row.oid
      ), '[]'::jsonb),
      'acl', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'grantor', pg_get_userbyid(acl_row.grantor),
            'grantee', CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            'privilege', acl_row.privilege_type,
            'grantable', acl_row.is_grantable
          )
          ORDER BY
            pg_get_userbyid(acl_row.grantor),
            CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_row.grantee) END,
            acl_row.privilege_type,
            acl_row.is_grantable
        )
        FROM aclexplode(COALESCE(type_row.typacl, acldefault('T', type_row.typowner))) acl_row
      ), '[]'::jsonb)
    )::text
  FROM pg_type type_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND type_row.typtype IN ('d', 'e', 'm', 'r')

  UNION ALL

  SELECT
    'relation'::text,
    namespace_row.nspname || '.' || relation_row.relname,
    jsonb_build_object(
      'kind', relation_row.relkind,
      'owner', pg_get_userbyid(relation_row.relowner),
      'persistence', relation_row.relpersistence,
      'rowSecurity', relation_row.relrowsecurity,
      'forceRowSecurity', relation_row.relforcerowsecurity,
      'isPartition', relation_row.relispartition,
      'partitionBound', pg_get_expr(relation_row.relpartbound, relation_row.oid, true),
      'options', COALESCE(to_jsonb(relation_row.reloptions), '[]'::jsonb),
      'acl', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'grantor', pg_get_userbyid(acl_row.grantor),
            'grantee', CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            'privilege', acl_row.privilege_type,
            'grantable', acl_row.is_grantable
          )
          ORDER BY
            pg_get_userbyid(acl_row.grantor),
            CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            acl_row.privilege_type,
            acl_row.is_grantable
        )
        FROM aclexplode(
          COALESCE(
            relation_row.relacl,
            acldefault(
              (CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
              relation_row.relowner
            )
          )
        ) acl_row
      ), '[]'::jsonb)
    )::text
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S')

  UNION ALL

  SELECT
    'column'::text,
    namespace_row.nspname || '.' || relation_row.relname || '.' || attribute_row.attname,
    jsonb_build_object(
      'position', attribute_row.attnum,
      'type', format_type(attribute_row.atttypid, attribute_row.atttypmod),
      'notNull', attribute_row.attnotnull,
      'default', pg_get_expr(default_row.adbin, default_row.adrelid, true),
      'identity', attribute_row.attidentity,
      'generated', attribute_row.attgenerated,
      'collation', CASE
        WHEN attribute_row.attcollation = 0 THEN NULL
        ELSE attribute_row.attcollation::regcollation::text
      END,
      'storage', attribute_row.attstorage,
      'compression', attribute_row.attcompression,
      'acl', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'grantor', pg_get_userbyid(acl_row.grantor),
            'grantee', CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            'privilege', acl_row.privilege_type,
            'grantable', acl_row.is_grantable
          )
          ORDER BY
            pg_get_userbyid(acl_row.grantor),
            CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              WHEN acl_row.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                THEN '$MIGRATION_ACTOR'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            acl_row.privilege_type,
            acl_row.is_grantable
        )
        FROM aclexplode(
          COALESCE(
            attribute_row.attacl,
            acldefault('c', relation_row.relowner)
          )
        ) acl_row
      ), '[]'::jsonb)
    )::text
  FROM pg_attribute attribute_row
  JOIN pg_class relation_row ON relation_row.oid = attribute_row.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  LEFT JOIN pg_attrdef default_row
    ON default_row.adrelid = attribute_row.attrelid
   AND default_row.adnum = attribute_row.attnum
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND relation_row.relkind IN ('r', 'p', 'v', 'm')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped

  UNION ALL

  SELECT
    'constraint'::text,
    namespace_row.nspname || '.' || relation_row.relname || '.' || constraint_row.conname,
    jsonb_build_object(
      'type', constraint_row.contype,
      'deferrable', constraint_row.condeferrable,
      'deferred', constraint_row.condeferred,
      'validated', constraint_row.convalidated,
      'noInherit', constraint_row.connoinherit,
      'definition', pg_get_constraintdef(constraint_row.oid, true)
    )::text
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])

  UNION ALL

  SELECT
    'index'::text,
    namespace_row.nspname || '.' || index_relation.relname,
    jsonb_build_object(
      'table', namespace_row.nspname || '.' || table_relation.relname,
      'owner', pg_get_userbyid(index_relation.relowner),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'clustered', index_row.indisclustered,
      'replicaIdentity', index_row.indisreplident,
      'definition', pg_get_indexdef(index_relation.oid),
      'options', COALESCE(to_jsonb(index_relation.reloptions), '[]'::jsonb)
    )::text
  FROM pg_index index_row
  JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_relation.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])

  UNION ALL

  SELECT
    'sequence'::text,
    namespace_row.nspname || '.' || sequence_relation.relname,
    jsonb_build_object(
      'type', format_type(sequence_row.seqtypid, NULL),
      'start', sequence_row.seqstart,
      'increment', sequence_row.seqincrement,
      'min', sequence_row.seqmin,
      'max', sequence_row.seqmax,
      'cache', sequence_row.seqcache,
      'cycle', sequence_row.seqcycle,
      'ownedBy', owned_namespace.nspname || '.' || owned_relation.relname || '.' || owned_attribute.attname
    )::text
  FROM pg_sequence sequence_row
  JOIN pg_class sequence_relation ON sequence_relation.oid = sequence_row.seqrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = sequence_relation.relnamespace
  LEFT JOIN pg_depend ownership
    ON ownership.classid = 'pg_class'::regclass
   AND ownership.objid = sequence_relation.oid
   AND ownership.deptype IN ('a', 'i')
   AND ownership.refclassid = 'pg_class'::regclass
  LEFT JOIN pg_class owned_relation ON owned_relation.oid = ownership.refobjid
  LEFT JOIN pg_namespace owned_namespace ON owned_namespace.oid = owned_relation.relnamespace
  LEFT JOIN pg_attribute owned_attribute
    ON owned_attribute.attrelid = ownership.refobjid
   AND owned_attribute.attnum = ownership.refobjsubid
  WHERE namespace_row.nspname = ANY ($1::text[])

  UNION ALL

  SELECT
    'view'::text,
    namespace_row.nspname || '.' || relation_row.relname,
    jsonb_build_object(
      'kind', relation_row.relkind,
      'definition', pg_get_viewdef(relation_row.oid, true),
      'options', COALESCE(to_jsonb(relation_row.reloptions), '[]'::jsonb)
    )::text
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND relation_row.relkind IN ('v', 'm')

  UNION ALL

  SELECT
    'rule'::text,
    namespace_row.nspname || '.' || relation_row.relname || '.' || rewrite_row.rulename,
    jsonb_build_object(
      'definition', pg_get_ruledef(rewrite_row.oid, true)
    )::text
  FROM pg_rewrite rewrite_row
  JOIN pg_class relation_row ON relation_row.oid = rewrite_row.ev_class
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND relation_row.relkind NOT IN ('v', 'm')
    AND rewrite_row.rulename <> '_RETURN'

  UNION ALL

  SELECT
    'function'::text,
    namespace_row.nspname || '.' || function_row.proname || '(' ||
      pg_get_function_identity_arguments(function_row.oid) || ')',
    jsonb_build_object(
      'owner', pg_get_userbyid(function_row.proowner),
      'language', language_row.lanname,
      'result', pg_get_function_result(function_row.oid),
      'kind', function_row.prokind,
      'volatility', function_row.provolatile,
      'strict', function_row.proisstrict,
      'securityDefiner', function_row.prosecdef,
      'leakproof', function_row.proleakproof,
      'parallel', function_row.proparallel,
      'config', COALESCE(to_jsonb(function_row.proconfig), '[]'::jsonb),
      'definition', pg_get_functiondef(function_row.oid),
      'acl', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'grantor', pg_get_userbyid(acl_row.grantor),
            'grantee', CASE
              WHEN acl_row.grantee = 0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(acl_row.grantee)
            END,
            'privilege', acl_row.privilege_type,
            'grantable', acl_row.is_grantable
          )
          ORDER BY
            pg_get_userbyid(acl_row.grantor),
            CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_row.grantee) END,
            acl_row.privilege_type,
            acl_row.is_grantable
        )
        FROM aclexplode(
          COALESCE(function_row.proacl, acldefault('f', function_row.proowner))
        ) acl_row
      ), '[]'::jsonb)
    )::text
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = function_row.prolang
  WHERE namespace_row.nspname = ANY ($1::text[])

  UNION ALL

  SELECT
    'policy'::text,
    policy_row.schemaname || '.' || policy_row.tablename || '.' || policy_row.policyname,
    jsonb_build_object(
      'permissive', policy_row.permissive,
      'roles', to_jsonb(policy_row.roles),
      'command', policy_row.cmd,
      'using', policy_row.qual,
      'check', policy_row.with_check
    )::text
  FROM pg_policies policy_row
  WHERE policy_row.schemaname = ANY ($1::text[])

  UNION ALL

  SELECT
    'trigger'::text,
    namespace_row.nspname || '.' || relation_row.relname || '.' || trigger_row.tgname,
    jsonb_build_object(
      'enabled', trigger_row.tgenabled,
      'definition', pg_get_triggerdef(trigger_row.oid, true)
    )::text
  FROM pg_trigger trigger_row
  JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
    AND NOT trigger_row.tgisinternal

  UNION ALL

  SELECT
    'default-acl'::text,
    pg_get_userbyid(default_acl.defaclrole) || ':' ||
      COALESCE(namespace_row.nspname, '*') || ':' || default_acl.defaclobjtype::text,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'grantor', pg_get_userbyid(acl_row.grantor),
          'grantee', CASE
            WHEN acl_row.grantee = 0 THEN 'PUBLIC'
            ELSE pg_get_userbyid(acl_row.grantee)
          END,
          'privilege', acl_row.privilege_type,
          'grantable', acl_row.is_grantable
        )
        ORDER BY
          pg_get_userbyid(acl_row.grantor),
          CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl_row.grantee) END,
          acl_row.privilege_type,
          acl_row.is_grantable
      )
      FROM aclexplode(default_acl.defaclacl) acl_row
    ), '[]'::jsonb)::text
  FROM pg_default_acl default_acl
  LEFT JOIN pg_namespace namespace_row ON namespace_row.oid = default_acl.defaclnamespace
  WHERE namespace_row.nspname = ANY ($1::text[])
     OR (
       default_acl.defaclnamespace = 0
       AND pg_get_userbyid(default_acl.defaclrole) = ANY (
         ARRAY['letletme_data_owner', 'letletme_data_writer', 'letletme_graphql_reader']::text[]
       )
     )

  UNION ALL

  SELECT
    'boundary'::text,
    'non_extension_public_objects'::text,
    COALESCE(jsonb_agg(
      jsonb_build_object('kind', public_relation.relkind, 'name', public_relation.relname)
      ORDER BY public_relation.relkind, public_relation.relname
    ), '[]'::jsonb)::text
  FROM pg_class public_relation
  JOIN pg_namespace public_namespace ON public_namespace.oid = public_relation.relnamespace
  WHERE public_namespace.nspname = 'public'
    AND public_relation.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_class'::regclass
        AND dependency.objid = public_relation.oid
        AND dependency.deptype = 'e'
    )

  UNION ALL

  SELECT
    'boundary'::text,
    'non_extension_public_functions'::text,
    COALESCE(jsonb_agg(
      public_function.proname || '(' || pg_get_function_identity_arguments(public_function.oid) || ')'
      ORDER BY public_function.proname, pg_get_function_identity_arguments(public_function.oid)
    ), '[]'::jsonb)::text
  FROM pg_proc public_function
  JOIN pg_namespace public_namespace ON public_namespace.oid = public_function.pronamespace
  WHERE public_namespace.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_proc'::regclass
        AND dependency.objid = public_function.oid
        AND dependency.deptype = 'e'
    )

  UNION ALL

  SELECT
    'boundary'::text,
    'non_extension_public_types'::text,
    COALESCE(jsonb_agg(
      jsonb_build_object('kind', public_type.typtype, 'name', public_type.typname)
      ORDER BY public_type.typtype, public_type.typname
    ), '[]'::jsonb)::text
  FROM pg_type public_type
  JOIN pg_namespace public_namespace ON public_namespace.oid = public_type.typnamespace
  WHERE public_namespace.nspname = 'public'
    AND public_type.typtype IN ('d', 'e')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend dependency
      WHERE dependency.classid = 'pg_type'::regclass
        AND dependency.objid = public_type.oid
        AND dependency.deptype = 'e'
    )

  UNION ALL

  SELECT
    'boundary'::text,
    'retired_objects'::text,
    jsonb_build_object(
      'drizzleSchema', to_regnamespace('drizzle') IS NOT NULL
    )::text
)
SELECT section, identity, definition
FROM contract_rows
ORDER BY section, identity, definition
`;

export async function loadPlatformSchemaContract(
  client: QueryClient,
): Promise<SchemaContractRow[]> {
  return client.unsafe<SchemaContractRow[]>(schemaContractQuery, [PLATFORM_SCHEMAS]);
}

export function serializeSchemaContract(rows: readonly SchemaContractRow[]): string {
  return [...rows]
    .sort((left, right) =>
      `${left.section}\u0000${left.identity}\u0000${left.definition}`.localeCompare(
        `${right.section}\u0000${right.identity}\u0000${right.definition}`,
      ),
    )
    .map((row) => `${row.section}\u0000${row.identity}\u0000${row.definition}`)
    .join('\n');
}

export function fingerprintSchemaContract(rows: readonly SchemaContractRow[]): string {
  return createHash('sha256').update(serializeSchemaContract(rows), 'utf8').digest('hex');
}

export async function loadReportingMaterializedViewState(
  client: QueryClient,
): Promise<ReportingMaterializedViewState[]> {
  const rows = await client<{ name: string; is_populated: boolean }[]>`
    SELECT relation_row.relname AS name, relation_row.relispopulated AS is_populated
    FROM pg_class relation_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'reporting'
      AND relation_row.relkind = 'm'
    ORDER BY relation_row.relname
  `;
  return rows.map((row) => ({ name: row.name, isPopulated: row.is_populated }));
}
