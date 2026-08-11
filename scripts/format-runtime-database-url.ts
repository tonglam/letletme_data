const mode = process.argv[2];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (mode !== 'derive-graphql' && mode !== 'with-password') {
  throw new Error('Expected derive-graphql or with-password');
}

const databaseUrl = new URL(
  mode === 'derive-graphql'
    ? required('DATA_RUNTIME_DATABASE_URL')
    : required('GRAPHQL_RUNTIME_DATABASE_URL'),
);

if (!databaseUrl.hostname || !databaseUrl.pathname || databaseUrl.pathname === '/') {
  throw new Error('Runtime database URL must include a database target');
}

if (mode === 'derive-graphql') {
  databaseUrl.username = 'letletme_graphql_runtime';
  databaseUrl.password = '';
} else {
  if (!databaseUrl.username) throw new Error('GraphQL runtime URL must include a username');
  databaseUrl.password = required('GRAPHQL_RUNTIME_DATABASE_PASSWORD');
}

process.stdout.write(databaseUrl.toString());
