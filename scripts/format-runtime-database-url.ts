export {};

const mode = process.argv[2];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function projectSuffix(value: string): string {
  const source = new URL(value);
  const username = decodeURIComponent(source.username);
  const separator = username.indexOf('.');
  return separator >= 0 ? username.slice(separator) : '';
}

if (
  mode !== 'derive-graphql' &&
  mode !== 'with-password' &&
  mode !== 'with-credentials' &&
  mode !== 'replace-password' &&
  mode !== 'extract-password'
) {
  throw new Error(
    'Expected derive-graphql, with-password, with-credentials, replace-password, or extract-password',
  );
}

const databaseUrl = new URL(
  mode === 'derive-graphql' || mode === 'with-password'
    ? mode === 'derive-graphql'
      ? required('DATA_RUNTIME_DATABASE_URL')
      : required('GRAPHQL_RUNTIME_DATABASE_URL')
    : required('DATABASE_URL'),
);

if (!databaseUrl.hostname || !databaseUrl.pathname || databaseUrl.pathname === '/') {
  throw new Error('Runtime database URL must include a database target');
}

if (mode === 'extract-password') {
  if (!databaseUrl.password) throw new Error('Runtime database URL must include a password');
  process.stdout.write(decodeURIComponent(databaseUrl.password));
} else if (mode === 'derive-graphql') {
  const sourceUsername = databaseUrl.username;
  const projectSuffix = sourceUsername.includes('.')
    ? sourceUsername.slice(sourceUsername.indexOf('.'))
    : '';
  databaseUrl.username = `letletme_graphql_runtime${projectSuffix}`;
  databaseUrl.password = '';
} else if (mode === 'with-password') {
  if (!databaseUrl.username) throw new Error('GraphQL runtime URL must include a username');
  databaseUrl.password = required('GRAPHQL_RUNTIME_DATABASE_PASSWORD');
} else if (mode === 'replace-password') {
  if (!databaseUrl.username) throw new Error('Runtime database URL must include a username');
  if (databaseUrl.hostname.endsWith('.pooler.supabase.com') && databaseUrl.port === '6543') {
    databaseUrl.port = '5432';
  }
  if (!databaseUrl.username.includes('.') && process.env.RUNTIME_DATABASE_SOURCE_URL) {
    databaseUrl.username += projectSuffix(required('RUNTIME_DATABASE_SOURCE_URL'));
  }
  databaseUrl.password = required('RUNTIME_DATABASE_PASSWORD');
} else {
  const sourceUsername = databaseUrl.username;
  const projectSuffix = sourceUsername.includes('.')
    ? sourceUsername.slice(sourceUsername.indexOf('.'))
    : '';
  databaseUrl.username = `${required('RUNTIME_DATABASE_USER')}${projectSuffix}`;
  databaseUrl.password = required('RUNTIME_DATABASE_PASSWORD');
}

if (mode !== 'extract-password') process.stdout.write(databaseUrl.toString());
