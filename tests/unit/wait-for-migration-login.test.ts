import { describe, expect, test } from 'bun:test';

import { classifyMigrationProbeFailure } from '../../scripts/wait-for-migration-login';

describe('bounded migration LOGIN probe', () => {
  test('fails authentication and configuration errors immediately', () => {
    expect(classifyMigrationProbeFailure('PostgresError code 28P01')).toBe('authentication');
    expect(classifyMigrationProbeFailure('password authentication failed for user')).toBe(
      'authentication',
    );
    expect(classifyMigrationProbeFailure('role is missing required membership')).toBe(
      'configuration',
    );
  });

  test('retries only connectivity, timeout, and circuit failures', () => {
    for (const output of [
      'ECIRCUITBREAKER circuit open',
      'CONNECT_TIMEOUT',
      'read ECONNRESET',
      'server closed the connection unexpectedly',
      'remaining connection slots are reserved',
    ]) {
      expect(classifyMigrationProbeFailure(output)).toBe('transient');
    }
  });
});
