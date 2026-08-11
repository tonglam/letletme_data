import { createHash } from 'node:crypto';

import postgres from 'postgres';

import {
  fingerprintPlatformDataManifest,
  loadPlatformDataManifest,
} from './platform-data-contract';
import {
  fingerprintSchemaContract,
  loadPlatformSchemaContract,
  loadReportingMaterializedViewState,
} from './platform-schema-contract';

const EXPECTED_LEDGER_COUNT = 99;
const EXPECTED_LEDGER_FIRST = '0006_align_event_lives_table_name.sql';
const EXPECTED_LEDGER_LAST = '0095_canonicalize_platform_contract.sql';
const EXPECTED_LEDGER_FINGERPRINT =
  '7e73ca4d98ecf3dbdf595eaa214c6ec609a7d538d57157f82f2fffed84842e27';

export const EXPECTED_PLATFORM_SCHEMA_FINGERPRINT =
  '378c6820b2c12ed6ca95ad198f31f9a702d2531594dc9427e9fdb3c6f33082fa';

const EXPECTED_PRE_ADOPTION_PLATFORM_SCHEMA_FINGERPRINT =
  '3bbb0ffb8c2c4ed7ede747b1e73216d58ddbdf208d12de5eaa7993e5c870c945';

export const EXPECTED_PRODUCTION_DATA_FINGERPRINT = [
  '69f4cdb2748dd486',
  '797d62d80dd25194',
  'f54aead8245a8c41',
  '37e1c068a2053a4',
].join('');

type QueryClient = postgres.Sql | postgres.TransactionSql;

type LedgerRow = {
  filename: string;
  checksum: string | null;
};

type CapabilityMembershipRow = {
  granted_role: string;
  member_role: string;
  admin_option: boolean;
};

type RuntimeRoleRow = {
  role_name: string;
  can_login: boolean;
  superuser: boolean;
  create_database: boolean;
  create_role: boolean;
  inherit: boolean;
  replication: boolean;
  bypass_rls: boolean;
  connection_limit: number;
  valid_until_ok: boolean;
  role_settings: string[];
};

type RuntimeMembershipRow = {
  login_role: string;
  granted_role: string;
  admin_option: boolean;
};

export type BaselineAdoptionExpectations = {
  ledgerFingerprint: string;
  schemaFingerprint: string;
  dataFingerprint: string;
};

export const PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS: BaselineAdoptionExpectations = {
  ledgerFingerprint: EXPECTED_LEDGER_FINGERPRINT,
  schemaFingerprint: EXPECTED_PLATFORM_SCHEMA_FINGERPRINT,
  dataFingerprint: EXPECTED_PRODUCTION_DATA_FINGERPRINT,
};

function fingerprintLedger(rows: readonly LedgerRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

async function loadLedger(client: QueryClient): Promise<LedgerRow[]> {
  return client<LedgerRow[]>`
    SELECT filename, checksum
    FROM ops.schema_migrations
    ORDER BY filename
  `;
}

function assertExpectedLedger(rows: readonly LedgerRow[], expectedFingerprint: string): void {
  if (
    rows.length !== EXPECTED_LEDGER_COUNT ||
    rows[0]?.filename !== EXPECTED_LEDGER_FIRST ||
    rows.at(-1)?.filename !== EXPECTED_LEDGER_LAST ||
    rows.some((row) => row.checksum === null) ||
    fingerprintLedger(rows) !== expectedFingerprint
  ) {
    throw new Error('Production migration ledger does not match the accepted canonical boundary');
  }
}

async function assertRetiredRoleAbsent(client: QueryClient): Promise<void> {
  const [{ exists }] = await client<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname LIKE 'letletme\\_%\\_frozen_owner' ESCAPE '\\'
    ) AS exists
  `;
  if (exists) throw new Error('Retired frozen-owner role still exists');
}

async function assertReportingViewsPopulated(client: QueryClient): Promise<void> {
  const states = await loadReportingMaterializedViewState(client);
  const expectedNames = ['tournament_entry_event_summaries', 'tournament_selection_stats'];
  if (
    states.length !== expectedNames.length ||
    states.some((state, index) => state.name !== expectedNames[index] || !state.isPopulated)
  ) {
    throw new Error('Production reporting materialized views are not fully populated');
  }
}

async function assertCapabilityRoleMemberships(client: QueryClient): Promise<void> {
  const [currentUser] = await client<{ role_name: string }[]>`
    SELECT current_user::text AS role_name
  `;
  if (!currentUser) throw new Error('Migration LOGIN identity is unavailable');

  const rows = await client<CapabilityMembershipRow[]>`
    WITH RECURSIVE capability_roles AS (
      SELECT oid
      FROM pg_roles
      WHERE rolname IN (
        'letletme_data_owner',
        'letletme_data_writer',
        'letletme_graphql_reader',
        'letletme_web_auth'
      )
    ),
    reachable_roles(role_oid) AS (
      SELECT oid FROM capability_roles
      UNION
      SELECT membership.member
      FROM pg_auth_members membership
      JOIN reachable_roles reachable ON reachable.role_oid = membership.roleid
    )
    SELECT
      granted_role.rolname AS granted_role,
      member_role.rolname AS member_role,
      membership.admin_option
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE membership.roleid IN (SELECT role_oid FROM reachable_roles)
       OR membership.member IN (SELECT oid FROM capability_roles)
    ORDER BY granted_role.rolname, member_role.rolname
  `;
  const allowed = new Set([
    `letletme_data_owner->${currentUser.role_name}`,
    'letletme_data_writer->letletme_data_runtime',
    'letletme_graphql_reader->letletme_graphql_runtime',
    'letletme_web_auth->letletme_web_runtime',
  ]);
  const observed = new Set(rows.map((row) => `${row.granted_role}->${row.member_role}`));
  const unexpected = rows.filter(
    (row) => row.admin_option || !allowed.has(`${row.granted_role}->${row.member_role}`),
  );
  const missing = [...allowed].filter((membership) => !observed.has(membership));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Unexpected capability role membership: ${
        unexpected.length > 0
          ? unexpected.map((row) => `${row.granted_role}->${row.member_role}`).join(', ')
          : 'none'
      }${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`,
    );
  }

  const runtimeRoles = await client<RuntimeRoleRow[]>`
    SELECT
      rolname AS role_name,
      rolcanlogin AS can_login,
      rolsuper AS superuser,
      rolcreatedb AS create_database,
      rolcreaterole AS create_role,
      rolinherit AS inherit,
      rolreplication AS replication,
      rolbypassrls AS bypass_rls,
      rolconnlimit AS connection_limit,
      (rolvaliduntil IS NULL OR rolvaliduntil > CURRENT_TIMESTAMP) AS valid_until_ok,
      COALESCE(rolconfig, ARRAY[]::text[]) AS role_settings
    FROM pg_roles
    WHERE rolname = ANY(${[
      'letletme_data_runtime',
      'letletme_graphql_runtime',
      'letletme_web_runtime',
    ]}::text[])
  `;
  const expectedRuntimeRoles = new Set([
    'letletme_data_runtime',
    'letletme_graphql_runtime',
    'letletme_web_runtime',
  ]);
  const capabilityRoles = await client<RuntimeRoleRow[]>`
    SELECT
      rolname AS role_name,
      rolcanlogin AS can_login,
      rolsuper AS superuser,
      rolcreatedb AS create_database,
      rolcreaterole AS create_role,
      rolinherit AS inherit,
      rolreplication AS replication,
      rolbypassrls AS bypass_rls,
      rolconnlimit AS connection_limit,
      (rolvaliduntil IS NULL OR rolvaliduntil > CURRENT_TIMESTAMP) AS valid_until_ok,
      COALESCE(rolconfig, ARRAY[]::text[]) AS role_settings
    FROM pg_roles
    WHERE rolname = ANY(${[
      'letletme_data_owner',
      'letletme_data_writer',
      'letletme_graphql_reader',
      'letletme_web_auth',
    ]}::text[])
  `;
  const expectedCapabilityRoles = new Set([
    'letletme_data_owner',
    'letletme_data_writer',
    'letletme_graphql_reader',
    'letletme_web_auth',
  ]);
  const unsafeCapabilityRoles = capabilityRoles.filter(
    (role) =>
      role.can_login ||
      role.superuser ||
      role.create_database ||
      role.create_role ||
      role.inherit ||
      role.replication ||
      role.bypass_rls ||
      role.role_settings.length > 0,
  );
  const missingCapabilityRoles = [...expectedCapabilityRoles].filter(
    (roleName) => !capabilityRoles.some((role) => role.role_name === roleName),
  );
  if (unsafeCapabilityRoles.length > 0 || missingCapabilityRoles.length > 0) {
    throw new Error(
      `Required capability roles are missing or unsafe: ${[
        ...missingCapabilityRoles,
        ...unsafeCapabilityRoles.map((role) => role.role_name),
      ].join(', ')}`,
    );
  }
  const unsafeRuntimeRoles = runtimeRoles.filter(
    (role) =>
      !role.can_login ||
      role.superuser ||
      role.create_database ||
      role.create_role ||
      !role.inherit ||
      role.replication ||
      role.bypass_rls ||
      role.connection_limit === 0 ||
      !role.valid_until_ok ||
      role.role_settings.length > 0,
  );
  const missingRuntimeRoles = [...expectedRuntimeRoles].filter(
    (roleName) => !runtimeRoles.some((role) => role.role_name === roleName),
  );
  if (unsafeRuntimeRoles.length > 0 || missingRuntimeRoles.length > 0) {
    throw new Error(
      `Required runtime LOGIN roles are missing or unsafe: ${[
        ...missingRuntimeRoles,
        ...unsafeRuntimeRoles.map((role) => role.role_name),
      ].join(', ')}`,
    );
  }

  const runtimeMemberships = await client<RuntimeMembershipRow[]>`
    WITH RECURSIVE inherited(login_role, role_oid, granted_role, admin_option, path) AS (
      SELECT
        member_role.rolname,
        granted_role.oid,
        granted_role.rolname,
        membership.admin_option,
        ARRAY[member_role.oid, granted_role.oid]
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = ANY(${[...expectedRuntimeRoles]}::text[])

      UNION ALL

      SELECT
        inherited.login_role,
        granted_role.oid,
        granted_role.rolname,
        membership.admin_option,
        inherited.path || granted_role.oid
      FROM inherited
      JOIN pg_auth_members membership ON membership.member = inherited.role_oid
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE NOT granted_role.oid = ANY(inherited.path)
    )
    SELECT login_role, granted_role, bool_or(admin_option) AS admin_option
    FROM inherited
    GROUP BY login_role, granted_role
    ORDER BY login_role, granted_role
  `;
  const expectedRuntimeMemberships = new Set([
    'letletme_data_runtime->letletme_data_writer',
    'letletme_graphql_runtime->letletme_graphql_reader',
    'letletme_web_runtime->letletme_web_auth',
  ]);
  const observedRuntimeMemberships = new Set(
    runtimeMemberships.map((row) => `${row.login_role}->${row.granted_role}`),
  );
  const unexpectedRuntimeMemberships = runtimeMemberships.filter(
    (row) =>
      row.admin_option || !expectedRuntimeMemberships.has(`${row.login_role}->${row.granted_role}`),
  );
  const missingRuntimeMemberships = [...expectedRuntimeMemberships].filter(
    (membership) => !observedRuntimeMemberships.has(membership),
  );
  if (unexpectedRuntimeMemberships.length > 0 || missingRuntimeMemberships.length > 0) {
    throw new Error(
      `Unexpected runtime LOGIN membership: ${[
        ...unexpectedRuntimeMemberships.map((row) => `${row.login_role}->${row.granted_role}`),
        ...missingRuntimeMemberships.map((membership) => `missing ${membership}`),
      ].join(', ')}`,
    );
  }
}

async function repairProductionReportingContract(client: QueryClient): Promise<void> {
  // The accepted production boundary predates these schema-only reporting repairs.
  // Keep this allowlist narrow so any unrelated drift still fails closed.
  const [ownerGrant] = await client<{ statement: string }[]>`
    SELECT format('GRANT %I TO %I', 'letletme_data_owner', current_user::text) AS statement
  `;
  if (!ownerGrant?.statement) throw new Error('Unable to prepare the migration owner grant');
  await client.unsafe(ownerGrant.statement);
  await client`
    CREATE INDEX IF NOT EXISTS tournament_knockouts_season_fk_idx
      ON competition.tournament_knockouts USING btree (season_id)
  `;
  await client`
    CREATE INDEX IF NOT EXISTS dataset_publications_season_fk_idx
      ON ops.dataset_publications USING btree (season_id)
  `;
  await client.unsafe(`
    CREATE OR REPLACE FUNCTION reporting.refresh_tournament_entry_event_summaries() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog'
        AS $$
DECLARE
  populated boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 2);
  SELECT ispopulated
    INTO populated
    FROM pg_matviews
   WHERE schemaname = 'reporting'
     AND matviewname = 'tournament_entry_event_summaries';
  IF populated THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_entry_event_summaries;
  ELSE
    REFRESH MATERIALIZED VIEW reporting.tournament_entry_event_summaries;
  END IF;
END
$$
  `);
  await client.unsafe(`
    CREATE OR REPLACE FUNCTION reporting.refresh_tournament_selection_stats() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path TO 'pg_catalog'
        AS $$
DECLARE
  populated boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(73001, 1);
  SELECT ispopulated
    INTO populated
    FROM pg_matviews
   WHERE schemaname = 'reporting'
     AND matviewname = 'tournament_selection_stats';
  IF populated THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.tournament_selection_stats;
  ELSE
    REFRESH MATERIALIZED VIEW reporting.tournament_selection_stats;
  END IF;
END
$$
  `);
}

export async function adoptProductionPlatformBaseline(
  transaction: postgres.TransactionSql,
  baselineFilename: string,
  baselineChecksum: string,
  expectations: BaselineAdoptionExpectations = PRODUCTION_BASELINE_ADOPTION_EXPECTATIONS,
): Promise<void> {
  if (expectations.dataFingerprint === 'PENDING_CANONICAL_ACTIVATION') {
    throw new Error('Production baseline data fingerprint has not been frozen');
  }

  const ledgerBefore = await loadLedger(transaction);
  assertExpectedLedger(ledgerBefore, expectations.ledgerFingerprint);
  await assertRetiredRoleAbsent(transaction);
  await assertReportingViewsPopulated(transaction);
  await assertCapabilityRoleMemberships(transaction);

  const schemaBefore = fingerprintSchemaContract(await loadPlatformSchemaContract(transaction));
  if (schemaBefore === EXPECTED_PRE_ADOPTION_PLATFORM_SCHEMA_FINGERPRINT) {
    await repairProductionReportingContract(transaction);
  } else if (schemaBefore !== expectations.schemaFingerprint) {
    throw new Error(
      `Platform schema fingerprint mismatch: expected=${expectations.schemaFingerprint} actual=${schemaBefore}`,
    );
  }
  await assertCapabilityRoleMemberships(transaction);

  const dataBefore = fingerprintPlatformDataManifest(await loadPlatformDataManifest(transaction));
  if (dataBefore !== expectations.dataFingerprint) {
    throw new Error(
      `Platform data fingerprint mismatch: expected=${expectations.dataFingerprint} actual=${dataBefore}`,
    );
  }

  await transaction`DELETE FROM ops.schema_migrations`;
  await transaction`
    INSERT INTO ops.schema_migrations (filename, checksum)
    VALUES (${baselineFilename}, ${baselineChecksum})
  `;

  const ledgerAfter = await loadLedger(transaction);
  if (
    ledgerAfter.length !== 1 ||
    ledgerAfter[0]?.filename !== baselineFilename ||
    ledgerAfter[0]?.checksum !== baselineChecksum
  ) {
    throw new Error('Canonical baseline ledger adoption did not converge to one row');
  }

  const schemaAfter = fingerprintSchemaContract(await loadPlatformSchemaContract(transaction));
  if (schemaAfter !== expectations.schemaFingerprint) {
    throw new Error('Schema did not converge to the canonical baseline while adopting the ledger');
  }

  const dataAfter = fingerprintPlatformDataManifest(await loadPlatformDataManifest(transaction));
  if (dataAfter !== dataBefore) {
    throw new Error('Business data or sequence state changed during baseline adoption');
  }
}
