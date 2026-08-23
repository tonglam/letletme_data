import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
});
