\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '10s';

\pset tuples_only off
\pset format csv

WITH owner_rows AS (
  SELECT
    'owner'::text AS record_type,
    'schema'::text AS object_type,
    namespace_row.nspname::text AS object_name,
    pg_get_userbyid(namespace_row.nspowner)::text AS owner_or_grantee,
    ''::text AS privilege,
    ''::text AS is_grantable
  FROM pg_namespace namespace_row
  WHERE namespace_row.nspname = 'public'

  UNION ALL

  SELECT
    'owner',
    CASE relation_row.relkind
      WHEN 'S' THEN 'sequence'
      WHEN 'm' THEN 'materialized_view'
      WHEN 'v' THEN 'view'
      WHEN 'p' THEN 'partitioned_table'
      ELSE 'table'
    END,
    namespace_row.nspname || '.' || relation_row.relname,
    pg_get_userbyid(relation_row.relowner),
    '',
    ''
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')

  UNION ALL

  SELECT
    'owner',
    'function',
    namespace_row.nspname || '.' || function_row.proname || '('
      || pg_get_function_identity_arguments(function_row.oid) || ')',
    pg_get_userbyid(function_row.proowner),
    '',
    ''
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'

  UNION ALL

  SELECT
    'owner',
    'enum',
    namespace_row.nspname || '.' || type_row.typname,
    pg_get_userbyid(type_row.typowner),
    '',
    ''
  FROM pg_type type_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
  WHERE namespace_row.nspname = 'public'
    AND type_row.typtype = 'e'
), acl_rows AS (
  SELECT
    'acl'::text AS record_type,
    'schema'::text AS object_type,
    namespace_row.nspname::text AS object_name,
    coalesce(grantee_row.rolname, 'PUBLIC')::text AS owner_or_grantee,
    acl_row.privilege_type::text AS privilege,
    acl_row.is_grantable::text AS is_grantable
  FROM pg_namespace namespace_row
  CROSS JOIN LATERAL aclexplode(
    coalesce(namespace_row.nspacl, acldefault('n', namespace_row.nspowner))
  ) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND acl_row.grantee <> namespace_row.nspowner

  UNION ALL

  SELECT
    'acl',
    CASE relation_row.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,
    namespace_row.nspname || '.' || relation_row.relname,
    coalesce(grantee_row.rolname, 'PUBLIC'),
    acl_row.privilege_type,
    acl_row.is_grantable::text
  FROM pg_class relation_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(
      relation_row.relacl,
      acldefault(
        CASE WHEN relation_row.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
        relation_row.relowner
      )
    )
  ) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
    AND acl_row.grantee <> relation_row.relowner

  UNION ALL

  SELECT
    'acl',
    'column',
    namespace_row.nspname || '.' || relation_row.relname || '.' || attribute_row.attname,
    coalesce(grantee_row.rolname, 'PUBLIC'),
    acl_row.privilege_type,
    acl_row.is_grantable::text
  FROM pg_attribute attribute_row
  JOIN pg_class relation_row ON relation_row.oid = attribute_row.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  CROSS JOIN LATERAL aclexplode(attribute_row.attacl) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND relation_row.relkind IN ('r', 'p', 'm', 'v')
    AND attribute_row.attnum > 0
    AND NOT attribute_row.attisdropped
    AND acl_row.grantee <> relation_row.relowner

  UNION ALL

  SELECT
    'acl',
    'function',
    namespace_row.nspname || '.' || function_row.proname || '('
      || pg_get_function_identity_arguments(function_row.oid) || ')',
    coalesce(grantee_row.rolname, 'PUBLIC'),
    acl_row.privilege_type,
    acl_row.is_grantable::text
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(function_row.proacl, acldefault('f', function_row.proowner))
  ) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND acl_row.grantee <> function_row.proowner

  UNION ALL

  SELECT
    'acl',
    'enum',
    namespace_row.nspname || '.' || type_row.typname,
    coalesce(grantee_row.rolname, 'PUBLIC'),
    acl_row.privilege_type,
    acl_row.is_grantable::text
  FROM pg_type type_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
  CROSS JOIN LATERAL aclexplode(
    coalesce(type_row.typacl, acldefault('T', type_row.typowner))
  ) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND type_row.typtype = 'e'
    AND acl_row.grantee <> type_row.typowner

  UNION ALL

  SELECT
    'acl',
    'default_' || default_acl_row.defaclobjtype::text,
    owner_row.rolname || '@' || namespace_row.nspname,
    coalesce(grantee_row.rolname, 'PUBLIC'),
    acl_row.privilege_type,
    acl_row.is_grantable::text
  FROM pg_default_acl default_acl_row
  JOIN pg_roles owner_row ON owner_row.oid = default_acl_row.defaclrole
  JOIN pg_namespace namespace_row ON namespace_row.oid = default_acl_row.defaclnamespace
  CROSS JOIN LATERAL aclexplode(default_acl_row.defaclacl) acl_row
  LEFT JOIN pg_roles grantee_row ON grantee_row.oid = acl_row.grantee
  WHERE namespace_row.nspname = 'public'
    AND acl_row.grantee <> default_acl_row.defaclrole
)
SELECT *
FROM (
  SELECT * FROM owner_rows
  UNION ALL
  SELECT * FROM acl_rows
) contract_rows
ORDER BY
  record_type,
  object_type,
  object_name,
  owner_or_grantee,
  privilege,
  is_grantable;

COMMIT;
