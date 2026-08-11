export {};

const mode = process.argv[2];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (mode !== 'derive-graphql' && mode !== 'with-password' && mode !== 'with-credentials') {
  throw new Error('Expected derive-graphql, with-password, or with-credentials');
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

if (mode === 'derive-graphql') {
  databaseUrl.username = 'letletme_graphql_runtime';
  databaseUrl.password = '';
} else if (mode === 'with-password') {
  if (!databaseUrl.username) throw new Error('GraphQL runtime URL must include a username');
  databaseUrl.password = required('GRAPHQL_RUNTIME_DATABASE_PASSWORD');
} else {
  const sourceUsername = databaseUrl.username;
  const projectSuffix = sourceUsername.includes('.')
    ? sourceUsername.slice(sourceUsername.indexOf('.'))
    : '';
  databaseUrl.username = `${required('RUNTIME_DATABASE_USER')}${projectSuffix}`;
  databaseUrl.password = required('RUNTIME_DATABASE_PASSWORD');
}

process.stdout.write(databaseUrl.toString());
