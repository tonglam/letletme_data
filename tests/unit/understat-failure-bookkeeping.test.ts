import { describe, expect, test } from 'bun:test';

import { understatFailureBookkeepingPlan } from '../../src/utils/understat-failure-bookkeeping';

describe('Understat failure bookkeeping', () => {
  test('keeps domain failure persistence enabled for malformed scheduler fences', () => {
    expect(understatFailureBookkeepingPlan({ obligationId: 'obligation-only' })).toEqual({
      recordDomainFailure: true,
      settleScheduler: false,
    });
    expect(understatFailureBookkeepingPlan({ obligationGeneration: 3 })).toEqual({
      recordDomainFailure: true,
      settleScheduler: false,
    });
  });

  test('settles scheduler state only for absent or complete fences', () => {
    expect(understatFailureBookkeepingPlan({})).toEqual({
      recordDomainFailure: true,
      settleScheduler: true,
    });
    expect(
      understatFailureBookkeepingPlan({
        obligationId: 'complete-obligation',
        obligationGeneration: 3,
      }),
    ).toEqual({ recordDomainFailure: true, settleScheduler: true });
  });
});
