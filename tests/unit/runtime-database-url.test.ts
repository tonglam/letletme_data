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
});
