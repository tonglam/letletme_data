import postgres from 'postgres';

export const DATA_RUNTIME_LOGIN = 'letletme_data_runtime';
export const GRAPHQL_RUNTIME_LOGIN = 'letletme_graphql_runtime';
export const DATA_RUNTIME_CAPABILITY = 'letletme_data_writer';
export const GRAPHQL_RUNTIME_CAPABILITY = 'letletme_graphql_reader';

export type RuntimeLoginTarget = 'data' | 'graphql';

export type RoleAttributes = {
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

export type RuntimeLoginSnapshot = {
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

const targetContracts = {
  data: {
    login: DATA_RUNTIME_LOGIN,
    capability: DATA_RUNTIME_CAPABILITY,
  },
  graphql: {
    login: GRAPHQL_RUNTIME_LOGIN,
    capability: GRAPHQL_RUNTIME_CAPABILITY,
  },
} as const;

export function parseRuntimeLoginBootstrapArgs(args: readonly string[]): RuntimeLoginTarget {
  if (args.length !== 1) {
    throw new Error('Runtime LOGIN bootstrap requires exactly one --target=data|graphql argument');
  }
  const match = args[0]?.match(/^--target=(data|graphql)$/);
  if (!match) {
    throw new Error(`Runtime LOGIN bootstrap does not accept arguments: ${args.join(' ')}`);
  }
  return match[1] as RuntimeLoginTarget;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type ParsedRuntimeDatabaseUrl = {
  readonly password: string;
};

export function assertRuntimeDatabaseUrl(
  value: string,
  expectedRole: string,
  variableName: string,
): ParsedRuntimeDatabaseUrl {
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
  const roleMatches = username === expectedRole || username.startsWith(`${expectedRole}.`);
  if (!parsed.hostname || !roleMatches || !password) {
    throw new Error(`${variableName} must include ${expectedRole} and its initial password`);
  }
  return { password };
}

type DatabaseTarget = {
  readonly databaseName: string;
  readonly hostname: string;
  readonly port: number;
  readonly projectRef: string | null;
};

function parseDatabaseTarget(value: string, variableName: string): DatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${variableName} must use the postgres or postgresql scheme`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !databaseName) {
    throw new Error(`${variableName} must include a database name`);
  }
  const directProject = parsed.hostname.match(/^db\.([^.]+)\.supabase\.co$/i)?.[1] ?? null;
  let username = '';
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error(`${variableName} contains invalid URL encoding`);
  }
  const usernameProject = username.includes('.')
    ? username.slice(username.lastIndexOf('.') + 1)
    : null;
  return {
    databaseName,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
    projectRef: directProject ?? usernameProject,
  };
}

export function assertRuntimeDatabaseTarget(
  migrationUrl: string,
  runtimeUrl: string,
  variableName: string,
): void {
  const migration = parseDatabaseTarget(migrationUrl, 'DATABASE_URL');
  const runtime = parseDatabaseTarget(runtimeUrl, variableName);
  if (migration.databaseName !== runtime.databaseName) {
    throw new Error(`${variableName} must target the same PostgreSQL database as DATABASE_URL`);
  }
  const sameProject =
    migration.projectRef !== null &&
    runtime.projectRef !== null &&
    migration.projectRef.toLowerCase() === runtime.projectRef.toLowerCase();
  const sameHost = migration.hostname === runtime.hostname;
  const samePort = migration.port === runtime.port;
  if (!sameProject && (!sameHost || !samePort)) {
    throw new Error(`${variableName} must target the same PostgreSQL project as DATABASE_URL`);
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

function assertRuntimeTargetSnapshot(
  snapshot: RuntimeLoginSnapshot,
  target: RuntimeLoginTarget,
  requireLogin: boolean,
): void {
  const contract = targetContracts[target];
  const capability = snapshot.roles.find((role) => role.roleName === contract.capability);
  if (!capability || !isLockedCapability(capability)) {
    throw new Error(`Runtime capability role ${contract.capability} is missing or unsafe`);
  }

  const login = snapshot.roles.find((role) => role.roleName === contract.login);
  if (!login) {
    if (requireLogin) throw new Error(`Runtime LOGIN ${contract.login} is missing or unsafe`);
    return;
  }
  if (!isSafeLogin(login)) {
    throw new Error(`Runtime LOGIN ${contract.login} is missing or unsafe`);
  }
  const memberships = snapshot.memberships.filter(
    (membership) => membership.loginRole === contract.login,
  );
  if (
    memberships.length !== 1 ||
    memberships[0]?.grantedRole !== contract.capability ||
    memberships[0].adminOption
  ) {
    throw new Error(`Runtime LOGIN ${contract.login} must inherit only ${contract.capability}`);
  }
}

export function assertRuntimeLoginSnapshot(snapshot: RuntimeLoginSnapshot): void {
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
    throw new Error('Runtime verification returned an unexpected role set');
  }
  assertRuntimeTargetSnapshot(snapshot, 'data', true);
  assertRuntimeTargetSnapshot(snapshot, 'graphql', true);
}

export async function inspectRuntimeLogins(client: QueryClient): Promise<RuntimeLoginSnapshot> {
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
      COALESCE(role_row.rolconfig, ARRAY[]::text[]) || COALESCE((
        SELECT array_agg(setting.value ORDER BY setting.value)
        FROM pg_db_role_setting database_setting
        CROSS JOIN LATERAL unnest(database_setting.setconfig) AS setting(value)
        WHERE database_setting.setrole = role_row.oid
          AND database_setting.setdatabase IN (
            0,
            (SELECT oid FROM pg_database WHERE datname = current_database())
          )
      ), ARRAY[]::text[]) AS role_settings
    FROM pg_roles role_row
    WHERE role_row.rolname = ANY(${roleNames}::text[])
    ORDER BY role_row.rolname
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
  operation: 'create' | 'grant',
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
      : await client<Array<{ statement: string }>>`
          SELECT format('GRANT %I TO %I', ${value}::text, ${login}::text) AS statement
        `;
  if (!row?.statement) throw new Error(`Unable to format runtime ${operation} statement`);
  return row.statement;
}

export async function bootstrapRuntimeLogin(
  client: QueryClient,
  target: RuntimeLoginTarget,
  password: string,
): Promise<boolean> {
  const contract = targetContracts[target];
  const before = await inspectRuntimeLogins(client);
  const existing = before.roles.find((role) => role.roleName === contract.login);
  if (existing) {
    assertRuntimeTargetSnapshot(before, target, true);
    return false;
  }

  assertRuntimeTargetSnapshot(before, target, false);
  const unexpectedMembership = before.memberships.some(
    (membership) => membership.loginRole === contract.login,
  );
  if (unexpectedMembership) {
    throw new Error(`Missing runtime LOGIN ${contract.login} has an unexpected membership`);
  }
  await client.unsafe(await formattedStatement(client, 'create', contract.login, password));
  await client.unsafe(
    await formattedStatement(client, 'grant', contract.login, contract.capability),
  );
  assertRuntimeTargetSnapshot(await inspectRuntimeLogins(client), target, true);
  return true;
}

export function runtimeLoginContract(target: RuntimeLoginTarget): {
  readonly login: string;
  readonly capability: string;
} {
  return targetContracts[target];
}
