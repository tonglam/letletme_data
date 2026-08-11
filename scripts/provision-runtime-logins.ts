/* eslint-disable no-console */
import postgres from 'postgres';

export const DATA_RUNTIME_LOGIN = 'letletme_data_runtime';
export const GRAPHQL_RUNTIME_LOGIN = 'letletme_graphql_runtime';
export const DATA_RUNTIME_CAPABILITY = 'letletme_data_writer';
export const GRAPHQL_RUNTIME_CAPABILITY = 'letletme_graphql_reader';

type RoleAttributes = {
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
  readonly connectionLimit: number;
  readonly validUntilOk: boolean;
  readonly settings: readonly string[];
};

export type RuntimeLoginProvisioningSnapshot = {
  readonly roles: readonly RoleAttributes[];
  readonly memberships: readonly {
    readonly loginRole: string;
    readonly grantedRole: string;
    readonly adminOption: boolean;
  }[];
};

type RoleRow = {
  readonly role_name: string;
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
  readonly rolreplication: boolean;
  readonly rolbypassrls: boolean;
  readonly rolconnlimit: number;
  readonly valid_until_ok: boolean;
  readonly role_settings: string[];
};

type QueryClient = postgres.Sql | postgres.TransactionSql;

const expectedCapabilities = new Map([
  [DATA_RUNTIME_LOGIN, DATA_RUNTIME_CAPABILITY],
  [GRAPHQL_RUNTIME_LOGIN, GRAPHQL_RUNTIME_CAPABILITY],
] as const);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPassword(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[A-Za-z0-9_-]{64}$/.test(value)) {
    throw new Error(`${name} must be an exact 64-character base64url secret`);
  }
  return value;
}

export function assertRuntimeDatabaseUrl(
  value: string,
  expectedRole: string,
  expectedPassword: string,
  variableName: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${variableName} must use the postgres or postgresql scheme`);
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error(`${variableName} contains invalid URL encoding`);
  }
  if (!parsed.hostname || username !== expectedRole || password !== expectedPassword) {
    throw new Error(`${variableName} must use ${expectedRole} and its configured password`);
  }
}

function roleAttributes(row: RoleRow): RoleAttributes {
  return {
    roleName: row.role_name,
    canLogin: row.rolcanlogin,
    superuser: row.rolsuper,
    createDatabase: row.rolcreatedb,
    createRole: row.rolcreaterole,
    inherit: row.rolinherit,
    replication: row.rolreplication,
    bypassRls: row.rolbypassrls,
    connectionLimit: row.rolconnlimit,
    validUntilOk: row.valid_until_ok,
    settings: row.role_settings,
  };
}

function isLockedCapability(role: RoleAttributes): boolean {
  return (
    !role.canLogin &&
    !role.superuser &&
    !role.createDatabase &&
    !role.createRole &&
    !role.inherit &&
    !role.replication &&
    !role.bypassRls &&
    role.settings.length === 0
  );
}

function isSafeLogin(role: RoleAttributes): boolean {
  return (
    role.canLogin &&
    !role.superuser &&
    !role.createDatabase &&
    !role.createRole &&
    role.inherit &&
    !role.replication &&
    !role.bypassRls &&
    role.connectionLimit !== 0 &&
    role.validUntilOk &&
    role.settings.length === 0
  );
}

export function assertRuntimeLoginProvisioningSnapshot(
  snapshot: RuntimeLoginProvisioningSnapshot,
): void {
  const expectedRoles = new Set([
    DATA_RUNTIME_LOGIN,
    GRAPHQL_RUNTIME_LOGIN,
    DATA_RUNTIME_CAPABILITY,
    GRAPHQL_RUNTIME_CAPABILITY,
  ]);
  if (
    snapshot.roles.length !== expectedRoles.size ||
    snapshot.roles.some((role) => !expectedRoles.has(role.roleName))
  ) {
    throw new Error('Runtime provisioning returned an unexpected role set');
  }

  for (const capability of [DATA_RUNTIME_CAPABILITY, GRAPHQL_RUNTIME_CAPABILITY]) {
    const role = snapshot.roles.find((candidate) => candidate.roleName === capability);
    if (!role || !isLockedCapability(role)) {
      throw new Error(`Runtime capability role ${capability} is missing or unsafe`);
    }
  }

  for (const [login, capability] of expectedCapabilities) {
    const role = snapshot.roles.find((candidate) => candidate.roleName === login);
    if (!role || !isSafeLogin(role)) {
      throw new Error(`Runtime LOGIN ${login} is missing or unsafe`);
    }
    const grants = snapshot.memberships.filter((membership) => membership.loginRole === login);
    if (grants.length !== 1 || grants[0]?.grantedRole !== capability || grants[0].adminOption) {
      throw new Error(`Runtime LOGIN ${login} must inherit only ${capability}`);
    }
  }
}

async function inspectRoles(client: QueryClient): Promise<RuntimeLoginProvisioningSnapshot> {
  const roleNames = [
    DATA_RUNTIME_LOGIN,
    GRAPHQL_RUNTIME_LOGIN,
    DATA_RUNTIME_CAPABILITY,
    GRAPHQL_RUNTIME_CAPABILITY,
  ];
  const roleRows = await client<RoleRow[]>`
      SELECT
        rolname AS role_name,
        rolcanlogin,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolinherit,
        rolreplication,
        rolbypassrls,
        rolconnlimit,
        (rolvaliduntil IS NULL OR rolvaliduntil > CURRENT_TIMESTAMP) AS valid_until_ok,
        COALESCE(rolconfig, ARRAY[]::text[]) AS role_settings
      FROM pg_roles
      WHERE rolname = ANY(${roleNames}::text[])
      ORDER BY rolname
    `;
  const membershipRows = await client<
    Array<{ login_role: string; granted_role: string; admin_option: boolean }>
  >`
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
        WHERE member_role.rolname = ANY(${[DATA_RUNTIME_LOGIN, GRAPHQL_RUNTIME_LOGIN]}::text[])

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
  return {
    roles: roleRows.map(roleAttributes),
    memberships: membershipRows.map((row) => ({
      loginRole: row.login_role,
      grantedRole: row.granted_role,
      adminOption: row.admin_option,
    })),
  };
}

async function formattedStatement(
  client: QueryClient,
  operation: 'create' | 'password' | 'grant',
  login: string,
  value: string,
): Promise<string> {
  const [row] =
    operation === 'create'
      ? await client<Array<{ statement: string }>>`
          SELECT format(
            'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
            ${login}::text,
            ${value}::text
          ) AS statement
        `
      : operation === 'password'
        ? await client<Array<{ statement: string }>>`
            SELECT format(
              'ALTER ROLE %I PASSWORD %L',
              ${login}::text,
              ${value}::text
            ) AS statement
          `
        : await client<Array<{ statement: string }>>`
            SELECT format('GRANT %I TO %I', ${value}::text, ${login}::text) AS statement
          `;
  if (!row?.statement) throw new Error(`Unable to format runtime ${operation} statement`);
  return row.statement;
}

async function provisionLogin(
  client: QueryClient,
  login: string,
  capability: string,
  password: string,
): Promise<void> {
  const before = await inspectRoles(client);
  const existing = before.roles.find((role) => role.roleName === login);
  if (existing && !isSafeLogin(existing)) {
    throw new Error(`Existing runtime LOGIN ${login} has unsafe attributes`);
  }
  const existingMemberships = before.memberships.filter(
    (membership) => membership.loginRole === login,
  );
  if (
    existingMemberships.some(
      (membership) => membership.grantedRole !== capability || membership.adminOption,
    )
  ) {
    throw new Error(`Existing runtime LOGIN ${login} has an unexpected membership`);
  }

  if (!existing) {
    await client.unsafe(await formattedStatement(client, 'create', login, password));
  } else {
    await client.unsafe(await formattedStatement(client, 'password', login, password));
  }
  if (!existingMemberships.some((membership) => membership.grantedRole === capability)) {
    await client.unsafe(await formattedStatement(client, 'grant', login, capability));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const preflight = args.length === 1 && args[0] === '--preflight';
  if (args.length > 0 && !preflight) {
    throw new Error(`Runtime LOGIN provisioning does not accept arguments: ${args.join(' ')}`);
  }
  const databaseUrl = requiredEnvironment('DATABASE_URL');
  const dataPassword = requiredPassword('DATA_RUNTIME_DB_PASSWORD');
  const graphqlPassword = requiredPassword('GRAPHQL_RUNTIME_DB_PASSWORD');
  if (dataPassword === graphqlPassword) {
    throw new Error('Data and GraphQL runtime passwords must be unique');
  }
  const dataRuntimeUrl = requiredEnvironment('DATA_RUNTIME_DATABASE_URL');
  const graphqlRuntimeUrl = requiredEnvironment('GRAPHQL_RUNTIME_DATABASE_URL');
  assertRuntimeDatabaseUrl(
    dataRuntimeUrl,
    DATA_RUNTIME_LOGIN,
    dataPassword,
    'DATA_RUNTIME_DATABASE_URL',
  );
  assertRuntimeDatabaseUrl(
    graphqlRuntimeUrl,
    GRAPHQL_RUNTIME_LOGIN,
    graphqlPassword,
    'GRAPHQL_RUNTIME_DATABASE_URL',
  );
  if (preflight) {
    console.log(
      JSON.stringify(
        {
          status: 'runtime_login_provisioning_preflight_passed',
          runtimeLogins: [DATA_RUNTIME_LOGIN, GRAPHQL_RUNTIME_LOGIN],
        },
        null,
        2,
      ),
    );
    return;
  }

  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await client.begin(async (transaction) => {
      const before = await inspectRoles(transaction);
      for (const capability of [DATA_RUNTIME_CAPABILITY, GRAPHQL_RUNTIME_CAPABILITY]) {
        const role = before.roles.find((candidate) => candidate.roleName === capability);
        if (!role || !isLockedCapability(role)) {
          throw new Error(`Runtime capability role ${capability} is missing or unsafe`);
        }
      }
      await provisionLogin(transaction, DATA_RUNTIME_LOGIN, DATA_RUNTIME_CAPABILITY, dataPassword);
      await provisionLogin(
        transaction,
        GRAPHQL_RUNTIME_LOGIN,
        GRAPHQL_RUNTIME_CAPABILITY,
        graphqlPassword,
      );
      assertRuntimeLoginProvisioningSnapshot(await inspectRoles(transaction));
    });

    const verified = await inspectRoles(client);
    assertRuntimeLoginProvisioningSnapshot(verified);
    console.log(
      JSON.stringify(
        {
          operation: 'provision-runtime-logins',
          roles: verified.roles,
          memberships: verified.memberships,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[provision-runtime-logins] failed', error);
    process.exitCode = 1;
  });
}
