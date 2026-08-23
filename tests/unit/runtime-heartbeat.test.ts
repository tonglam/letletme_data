import { describe, expect, test } from 'bun:test';

import {
  isRuntimeHeartbeatHealthy,
  RUNTIME_HEARTBEAT_MAX_AGE_MS,
  type RuntimeHeartbeat,
} from '../../src/utils/runtime-heartbeat';

const now = Date.parse('2026-08-23T01:00:00.000Z');

function heartbeat(overrides: Partial<RuntimeHeartbeat> = {}): RuntimeHeartbeat {
  return {
    role: 'scheduler',
    releaseSha: 'a'.repeat(40),
    lastSeenAt: new Date(now).toISOString(),
    ...overrides,
  };
}

describe('runtime heartbeat release identity', () => {
  test('accepts a fresh heartbeat from the expected release', () => {
    expect(isRuntimeHeartbeatHealthy(heartbeat(), 'a'.repeat(40), now)).toBe(true);
  });

  test('rejects a fresh heartbeat from a different release', () => {
    expect(isRuntimeHeartbeatHealthy(heartbeat(), 'b'.repeat(40), now)).toBe(false);
  });

  test('rejects stale and malformed timestamps', () => {
    expect(
      isRuntimeHeartbeatHealthy(
        heartbeat({ lastSeenAt: new Date(now - RUNTIME_HEARTBEAT_MAX_AGE_MS - 1).toISOString() }),
        'a'.repeat(40),
        now,
      ),
    ).toBe(false);
    expect(
      isRuntimeHeartbeatHealthy(heartbeat({ lastSeenAt: 'not-a-timestamp' }), 'a'.repeat(40), now),
    ).toBe(false);
  });
});
