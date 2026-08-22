import { describe, expect, test } from 'bun:test';

import { isEditorialAcquisitionRunComplete } from '../../../src/content/editorial/editorial-repository';

describe('editorial acquisition readiness', () => {
  test('accepts formal terminal success statuses and rejects failure-like states', () => {
    for (const status of ['COMPLETED', 'CHECKED_NO_CHANGE', 'EMPTY', 'PARTIAL']) {
      expect(isEditorialAcquisitionRunComplete(status)).toBe(true);
    }
    for (const status of ['FAILED', 'GAP', 'SATURATED', 'BUDGET_DEFERRED', 'RUNNING']) {
      expect(isEditorialAcquisitionRunComplete(status)).toBe(false);
    }
  });
});
