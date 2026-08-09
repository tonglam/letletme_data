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
        ) AS wrong_public_owner_count
      FROM pg_roles role_row
      WHERE role_row.rolname = current_user
    `;
    const base = baseRows[0];
    if (!base) throw new Error('Migration LOGIN role is unavailable');

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
