import { describe, expect, test } from 'bun:test';

type RunResult = {
  readonly status: number;
  readonly stdout: string;
};

async function runFormatter(mode: string, environment: Record<string, string>): Promise<RunResult> {
  const child = Bun.spawn(['bun', 'scripts/format-runtime-database-url.ts', mode], {
    env: { ...process.env, ...environment },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const stdout = await new Response(child.stdout).text();
  return { status: await child.exited, stdout };
}

describe('runtime database URL formatter', () => {
  test('derives the GraphQL runtime identity from the Data URL', async () => {
    const result = await runFormatter('derive-graphql', {
      DATA_RUNTIME_DATABASE_URL: 'postgresql://data_runtime:secret@db.example:5432/app',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('postgresql://letletme_graphql_runtime@db.example:5432/app');
  });

  test('adds the GraphQL runtime password without changing the target', async () => {
    const result = await runFormatter('with-password', {
      GRAPHQL_RUNTIME_DATABASE_URL: 'postgresql://graphql_runtime@db.example:5432/app',
      GRAPHQL_RUNTIME_DATABASE_PASSWORD: 'p@ss/word',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('postgresql://graphql_runtime:p%40ss%2Fword@db.example:5432/app');
  });

  test('sets runtime credentials while preserving the migration target query', async () => {
    const result = await runFormatter('with-credentials', {
      DATABASE_URL: 'postgresql://postgres:admin@db.example:5432/app?options=project%3Dabc',
      RUNTIME_DATABASE_USER: 'letletme_data_runtime',
      RUNTIME_DATABASE_PASSWORD: 'p@ss/word',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'postgresql://letletme_data_runtime:p%40ss%2Fword@db.example:5432/app?options=project%3Dabc',
    );
  });

  test('preserves the Supabase pooler project suffix on runtime users', async () => {
    const result = await runFormatter('with-credentials', {
      DATABASE_URL:
        'postgresql://postgres.projectref:admin@aws-0-region.pooler.supabase.com:6543/postgres',
      RUNTIME_DATABASE_USER: 'letletme_data_runtime',
      RUNTIME_DATABASE_PASSWORD: 'runtime-secret',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'postgresql://letletme_data_runtime.projectref:runtime-secret@aws-0-region.pooler.supabase.com:6543/postgres',
    );
  });

  test('replaces the password without changing the configured runtime target', async () => {
    const result = await runFormatter('replace-password', {
      DATABASE_URL:
        'postgresql://letletme_data_runtime:old-secret@db.example:6543/app?pgbouncer=true',
      RUNTIME_DATABASE_PASSWORD: 'runtime-secret',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'postgresql://letletme_data_runtime:runtime-secret@db.example:6543/app?pgbouncer=true',
    );
  });

  test('preserves the project suffix when deriving the GraphQL runtime target', async () => {
    const result = await runFormatter('derive-graphql', {
      DATA_RUNTIME_DATABASE_URL:
        'postgresql://letletme_data_runtime.projectref:runtime-secret@aws-0-region.pooler.supabase.com:5432/postgres',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'postgresql://letletme_graphql_runtime.projectref@aws-0-region.pooler.supabase.com:5432/postgres',
    );
  });

  test('extracts the configured runtime password without changing it', async () => {
    const result = await runFormatter('extract-password', {
      DATABASE_URL: 'postgresql://letletme_data_runtime:p%40ss%2Fword@db.example:5432/app',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('p@ss/word');
  });
});
