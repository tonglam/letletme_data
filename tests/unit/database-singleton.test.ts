import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  databaseTransactionStorage,
  registerDatabasePostCommit,
  runDatabasePostCommitActions,
} from '../../src/db/singleton';

const singletonSource = readFileSync('src/db/singleton.ts', 'utf8');

describe('database singleton connection coordination', () => {
  test('shares the in-flight connection promise with every concurrent caller', () => {
    expect(singletonSource).toContain('private connectPromise: Promise<void> | null = null');
    expect(singletonSource).toContain(
      'if (this.connectPromise) {\n      return this.connectPromise;',
    );
    expect(singletonSource).toContain('const sharedAttempt = attempt.finally');
    expect(singletonSource).not.toContain('while (this.isConnecting)');
  });

  test('queues post-commit actions in the active transaction and drains them once', async () => {
    const actions: Array<() => Promise<void> | void> = [];
    const seen: string[] = [];

    await databaseTransactionStorage.run(
      { raw: {} as never, db: {} as never, postCommitActions: actions },
      async () => {
        registerDatabasePostCommit(() => {
          seen.push('first');
        });
        registerDatabasePostCommit(async () => {
          seen.push('second');
        });
      },
    );

    expect(seen).toEqual([]);
    await runDatabasePostCommitActions(actions);
    expect(seen).toEqual(['first', 'second']);
    expect(actions).toHaveLength(0);
  });
});
