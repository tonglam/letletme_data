/* eslint-disable no-console */
import postgres from 'postgres';

import {
  assertV3MigrationLoginSnapshot,
  type MigrationLoginSnapshot,
} from './v3-migration-login-gate';

type BaseContractRow = {
  role_name: string;
  session_user: string;
  server_major: number;
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  has_ops_ledger: boolean;
  public_relation_count: number;
  public_function_count: number;
  public_enum_count: number;
  wrong_public_owner_count: number;
  has_public_league_trends_catalog: boolean;
  graphql_mainline_functions_valid: boolean;
  invalid_preactivation_schema_count: number;
  preactivation_schema_object_count: number;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const baseRows = await sql<BaseContractRow[]>`
      SELECT
        current_user::text AS role_name,
        session_user::text AS session_user,
        current_setting('server_version_num')::integer / 10000 AS server_major,
        role_row.rolcanlogin,
        role_row.rolcreaterole,
        role_row.rolinherit,
        role_row.rolreplication,
        role_row.rolbypassrls,
        to_regclass('ops.schema_migrations') IS NOT NULL AS has_ops_ledger,
        (
          SELECT count(*)::integer FROM pg_class relation_row
          WHERE relation_row.relnamespace = 'public'::regnamespace
            AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
        ) AS public_relation_count,
        (
          SELECT count(*)::integer FROM pg_proc function_row
          WHERE function_row.pronamespace = 'public'::regnamespace
        ) AS public_function_count,
        (
          SELECT count(*)::integer FROM pg_type type_row
          WHERE type_row.typnamespace = 'public'::regnamespace
            AND type_row.typtype = 'e'
        ) AS public_enum_count,
        (
          SELECT count(*)::integer
          FROM (
            SELECT relation_row.relowner AS owner_oid
            FROM pg_class relation_row
            WHERE relation_row.relnamespace = 'public'::regnamespace
              AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')
            UNION ALL
            SELECT function_row.proowner
            FROM pg_proc function_row
            WHERE function_row.pronamespace = 'public'::regnamespace
            UNION ALL
            SELECT type_row.typowner
            FROM pg_type type_row
            WHERE type_row.typnamespace = 'public'::regnamespace
              AND type_row.typtype = 'e'
          ) owned_objects
          WHERE owned_objects.owner_oid <> role_row.oid
        ) AS wrong_public_owner_count,
        to_regclass('public.public_league_trends_catalog') IS NOT NULL
          AS has_public_league_trends_catalog,
        (
          SELECT count(*) = 2 AND bool_and(function_row.proowner = role_row.oid)
          FROM pg_proc function_row
          WHERE function_row.pronamespace = 'public'::regnamespace
            AND (
              (
                function_row.proname = 'search_players_for_picker'
                AND oidvectortypes(function_row.proargtypes) =
                  'text, integer, integer, integer, integer, integer, integer'
              )
              OR (
                function_row.proname = 'touch_public_league_trends_catalog_updated_at'
                AND oidvectortypes(function_row.proargtypes) = ''
              )
            )
        ) AS graphql_mainline_functions_valid,
        (
          SELECT count(*)::integer
          FROM pg_namespace namespace_row
          WHERE namespace_row.nspname IN (
            'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops'
          )
            AND (
              namespace_row.nspname <> 'fpl'
              OR namespace_row.nspowner <> role_row.oid
            )
        ) AS invalid_preactivation_schema_count,
        (
          SELECT count(*)::integer
          FROM (
            SELECT relation_row.oid
            FROM pg_class relation_row
            JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
            WHERE namespace_row.nspname IN (
              'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops'
            )
              AND relation_row.relkind IN ('r', 'p', 'm', 'v', 'S')

            UNION ALL

            SELECT function_row.oid
            FROM pg_proc function_row
            JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
            WHERE namespace_row.nspname IN (
              'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops'
            )

            UNION ALL

            SELECT type_row.oid
            FROM pg_type type_row
            JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
            WHERE namespace_row.nspname IN (
              'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops'
            )
              AND type_row.typtype IN ('d', 'e')
          ) preactivation_objects
        ) AS preactivation_schema_object_count
      FROM pg_roles role_row
      WHERE role_row.rolname = current_user
    `;
    const base = baseRows[0];
    if (!base) throw new Error('Migration LOGIN role is unavailable');

    let publicLeagueTrendsCatalogState: MigrationLoginSnapshot['publicLeagueTrendsCatalogState'] =
      'absent';
    let publicLeagueTrendsCatalogRows = 0;
    let publicLeagueTrendsCatalogOrphans = 0;
    if (base.has_public_league_trends_catalog) {
      const catalogRows = await sql<
        Array<{
          shape_valid: boolean;
          row_count: number;
          orphan_count: number;
        }>
      >`
        SELECT
          catalog_relation.relkind = 'r'
            AND catalog_relation.relowner = role_row.oid
            AND (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'name', attribute_row.attname,
                  'type', format_type(attribute_row.atttypid, attribute_row.atttypmod),
                  'notNull', attribute_row.attnotnull
                )
                ORDER BY attribute_row.attnum
              )
              FROM pg_attribute attribute_row
              WHERE attribute_row.attrelid = catalog_relation.oid
                AND attribute_row.attnum > 0
                AND NOT attribute_row.attisdropped
            ) = jsonb_build_array(
              jsonb_build_object('name', 'tournament_id', 'type', 'integer', 'notNull', true),
              jsonb_build_object('name', 'display_name', 'type', 'text', 'notNull', true),
              jsonb_build_object('name', 'sort_order', 'type', 'integer', 'notNull', true),
              jsonb_build_object('name', 'enabled', 'type', 'boolean', 'notNull', true),
              jsonb_build_object(
                'name',
                'published_at',
                'type',
                'timestamp with time zone',
                'notNull',
                true
              ),
              jsonb_build_object(
                'name',
                'updated_at',
                'type',
                'timestamp with time zone',
                'notNull',
                true
              )
            ) AS shape_valid,
          (SELECT count(*)::integer FROM public.public_league_trends_catalog) AS row_count,
          (
            SELECT count(*)::integer
            FROM public.public_league_trends_catalog source_catalog
            LEFT JOIN public.tournament_infos tournament
              ON tournament.id = source_catalog.tournament_id
            WHERE tournament.id IS NULL
          ) AS orphan_count
        FROM pg_class catalog_relation
        JOIN pg_roles role_row ON role_row.rolname = current_user
        WHERE catalog_relation.oid = 'public.public_league_trends_catalog'::regclass
      `;
      const catalog = catalogRows[0];
      publicLeagueTrendsCatalogState = catalog?.shape_valid ? 'valid' : 'invalid';
      publicLeagueTrendsCatalogRows = catalog?.row_count ?? 0;
      publicLeagueTrendsCatalogOrphans = catalog?.orphan_count ?? 0;
    }

    const inheritedRows = await sql<Array<{ role_name: string }>>`
      WITH RECURSIVE inherited(role_oid, role_name, path) AS (
        SELECT granted_role.oid, granted_role.rolname, ARRAY[member_role.oid, granted_role.oid]
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = current_user

        UNION ALL

        SELECT granted_role.oid, granted_role.rolname, inherited.path || granted_role.oid
        FROM inherited
        JOIN pg_auth_members membership ON membership.member = inherited.role_oid
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE NOT granted_role.oid = ANY(inherited.path)
      )
      SELECT DISTINCT role_name FROM inherited ORDER BY role_name
    `;

    let migrationState: MigrationLoginSnapshot['migrationState'] = 'preactivation';
    let canWriteMigrationLedger = false;
    if (base.has_ops_ledger) {
      const stateRows = await sql<Array<{ activated: boolean; can_write_ledger: boolean }>>`
        SELECT
          EXISTS (
            SELECT 1 FROM ops.migration_runs
            WHERE run_id = 'v3-20260808T160008Z-b9eddc0' AND status = 'activated'
          ) AS activated,
          has_table_privilege(
            current_user,
            'ops.schema_migrations',
            'SELECT,INSERT,UPDATE'
          ) AS can_write_ledger
      `;
      migrationState = stateRows[0]?.activated ? 'activated' : 'building';
      canWriteMigrationLedger = stateRows[0]?.can_write_ledger ?? false;
    }

    const snapshot: MigrationLoginSnapshot = {
      roleName: base.role_name,
      sessionUser: base.session_user,
      serverMajor: base.server_major,
      canLogin: base.rolcanlogin,
      createRole: base.rolcreaterole,
      inherit: base.rolinherit,
      replication: base.rolreplication,
      bypassRls: base.rolbypassrls,
      migrationState,
      publicRelationCount: base.public_relation_count,
      publicFunctionCount: base.public_function_count,
      publicEnumCount: base.public_enum_count,
      wrongPublicOwnerCount: base.wrong_public_owner_count,
      publicLeagueTrendsCatalogState,
      publicLeagueTrendsCatalogRows,
      publicLeagueTrendsCatalogOrphans,
      graphqlMainlineFunctionsValid: base.graphql_mainline_functions_valid,
      invalidPreactivationSchemaCount: base.invalid_preactivation_schema_count,
      preactivationSchemaObjectCount: base.preactivation_schema_object_count,
      inheritedRoles: inheritedRows.map((row) => row.role_name),
      canWriteMigrationLedger,
    };
    assertV3MigrationLoginSnapshot(snapshot);

    console.log(
      JSON.stringify(
        {
          status: 'v3_migration_login_contract_passed',
          roleName: snapshot.roleName,
          serverMajor: snapshot.serverMajor,
          migrationState: snapshot.migrationState,
          publicScope: {
            relations: snapshot.publicRelationCount,
            functions: snapshot.publicFunctionCount,
            enums: snapshot.publicEnumCount,
            wrongOwners: snapshot.wrongPublicOwnerCount,
            publicLeagueTrendsCatalog: {
              state: snapshot.publicLeagueTrendsCatalogState,
              rows: snapshot.publicLeagueTrendsCatalogRows,
              orphans: snapshot.publicLeagueTrendsCatalogOrphans,
            },
            graphqlMainlineFunctionsValid: snapshot.graphqlMainlineFunctionsValid,
          },
          preactivationTargetSchemas: {
            invalidSchemas: snapshot.invalidPreactivationSchemaCount,
            objects: snapshot.preactivationSchemaObjectCount,
          },
          inheritedRoles: snapshot.inheritedRoles,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('[v3-migration-login-contract] failed', error);
  process.exitCode = 1;
});
