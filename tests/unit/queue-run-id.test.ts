import { describe, expect, test } from 'bun:test';

import { createQueueRunAttemptId } from '../../src/utils/queue-run-id';

describe('queue run attempt IDs', () => {
  test('returns UUIDs accepted by sync_runs.run_id', () => {
    const first = createQueueRunAttemptId();
    const second = createQueueRunAttemptId();
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(first).toMatch(uuidPattern);
    expect(second).toMatch(uuidPattern);
    expect(second).not.toBe(first);
  });
});
