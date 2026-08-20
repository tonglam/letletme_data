import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { CliGrokRunner, type GrokRunInput } from '../../../src/content/acquisition/grok-runner';

const fixtureBinary = resolve(process.cwd(), 'tests/fixtures/fake-grok-cli.sh');
const input: GrokRunInput = {
  mode: 'poll',
  profile: 'week',
  runId: '550e8400-e29b-41d4-a716-446655440000',
  sourceSnapshotRevision: 'a'.repeat(64),
  sources: [],
  windowStart: '2026-08-20T09:00:00.000Z',
  windowEnd: '2026-08-20T10:00:00.000Z',
  maxXCalls: 2,
};

const originalMode = process.env.FAKE_GROK_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.FAKE_GROK_MODE;
  else process.env.FAKE_GROK_MODE = originalMode;
});

async function runFixture(mode: string, timeoutMs = 1_000) {
  process.env.FAKE_GROK_MODE = mode;
  return new CliGrokRunner(fixtureBinary, timeoutMs).run(input);
}

describe('headless Grok runner', () => {
  test('makes the tracked skill and references available from the isolated cwd', async () => {
    const result = await runFixture('require-skill');
    expect(result.status).toBe('COMPLETED');
    expect(result.traceVerified).toBe(true);
    expect(result.xCallCount).toBe(1);
  });

  test('counts a real X tool event independently of the model result', async () => {
    const result = await runFixture('normal');
    expect(result.status).toBe('COMPLETED');
    expect(result.traceVerified).toBe(true);
    expect(result.xCallCount).toBe(1);
    expect(result.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.responseHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('fails closed when a completed response has no X trace', async () => {
    const result = await runFixture('no-trace');
    expect(result.status).toBe('COMPLETED');
    expect(result.traceVerified).toBe(false);
    expect(result.xCallCount).toBe(0);
  });

  test('does not infer an X trace from assistant text or another tool', async () => {
    const result = await runFixture('false-positive');
    expect(result.status).toBe('COMPLETED');
    expect(result.traceVerified).toBe(false);
    expect(result.xCallCount).toBe(0);
  });

  test('fails closed when a receipt does not satisfy the canonical schema', async () => {
    const result = await runFixture('invalid-receipt');
    expect(result.status).toBe('FAILED');
    expect(result.traceVerified).toBe(false);
    expect(result.xCallCount).toBe(1);
    expect(result.receipts).toEqual([]);
    expect(result.error).toBe('Invalid Grok receipt schema');
  });

  test('handles auth expiry, invalid JSON, timeout and oversized output', async () => {
    const expired = await runFixture('auth-expired');
    expect(expired.status).toBe('FAILED');
    expect(expired.error).toContain('auth expired');

    const invalid = await runFixture('invalid-json');
    expect(invalid.status).toBe('FAILED');
    expect(invalid.error).toContain('Invalid Grok streaming JSON output');

    const timeout = await runFixture('timeout', 20);
    expect(timeout.status).toBe('FAILED');
    expect(timeout.error).toContain('timed out');

    const oversized = await runFixture('oversized');
    expect(oversized.status).toBe('FAILED');
    expect(oversized.error).toContain('exceeded 2 MiB');
  });
});
