import { describe, expect, test } from 'bun:test';

import {
  assertExactV3CoreCacheApproval,
  V3_CORE_CACHE_APPROVAL_PREFIX,
} from '../../scripts/v3-core-cache-gate';

const runId = 'v3-20260808T160008Z-b9eddc0';

describe('v3 core cache publication gate', () => {
  test('accepts only the exact run-bound approval', () => {
    expect(() =>
      assertExactV3CoreCacheApproval(`${V3_CORE_CACHE_APPROVAL_PREFIX}${runId}`, runId),
    ).not.toThrow();
  });

  test('rejects missing, wrong, and malformed approvals', () => {
    expect(() => assertExactV3CoreCacheApproval(undefined, runId)).toThrow(
      'V3_CORE_CACHE_APPROVAL',
    );
    expect(() =>
      assertExactV3CoreCacheApproval('APPROVE_V3_CORE_CACHE another-run', runId),
    ).toThrow('V3_CORE_CACHE_APPROVAL');
    expect(() =>
      assertExactV3CoreCacheApproval(`${V3_CORE_CACHE_APPROVAL_PREFIX}${runId}`, 'bad'),
    ).toThrow('CUTOVER_RUN_ID');
  });
});
