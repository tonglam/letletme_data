import { describe, expect, test } from 'bun:test';

import { formalAcquisitionJobId } from '../../../src/content/acquisition/formal-run-repository';

describe('formal acquisition job IDs', () => {
  const base = {
    targetId: 'partition-id',
    jobKind: 'X_KEYWORD_SCAN',
    windowEnd: new Date('2026-08-24T11:47:04.453Z'),
    profileRevision: 1,
    attemptNo: 1,
  } as const;

  test('separates requests with the same target/window and different immutable request hashes', () => {
    expect(formalAcquisitionJobId({ ...base, requestHash: 'old-request' })).not.toBe(
      formalAcquisitionJobId({ ...base, requestHash: 'new-request' }),
    );
  });

  test('is deterministic for the same request identity', () => {
    expect(formalAcquisitionJobId({ ...base, requestHash: 'request' })).toBe(
      formalAcquisitionJobId({ ...base, requestHash: 'request' }),
    );
  });
});
