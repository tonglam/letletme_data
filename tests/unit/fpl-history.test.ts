import { describe, expect, test } from 'bun:test';

import { evaluateFplArchiveEligibility } from '../../src/repositories/fpl-history';

const readyFacts = {
  eventCount: 38,
  minEventId: 1,
  maxEventId: 38,
  distinctEventIds: 38,
  finalizedEventCount: 38,
  fixtureCount: 380,
  finishedCount: 380,
  fixtureEventCount: 38,
  invalidEventCount: 0,
};

describe('FPL season archive eligibility', () => {
  test('does not archive a 379-fixture season', () => {
    const result = evaluateFplArchiveEligibility({
      ...readyFacts,
      fixtureCount: 379,
      finishedCount: 379,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('fixtures=379/380');
  });

  test('requires every one of the 380 fixtures to be finished', () => {
    const result = evaluateFplArchiveEligibility({ ...readyFacts, finishedCount: 379 });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('not all 380 fixtures are finished');
  });

  test('requires exact event IDs and all finalized live snapshots', () => {
    const result = evaluateFplArchiveEligibility({
      ...readyFacts,
      minEventId: 2,
      maxEventId: 39,
      finalizedEventCount: 37,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('event IDs are not exactly 1..38');
    expect(result.reason).toContain('finalized events=37/38');
  });

  test('allows blank gameweeks when every fixture event ID is valid', () => {
    const result = evaluateFplArchiveEligibility({
      ...readyFacts,
      fixtureEventCount: 37,
    });

    expect(result.eligible).toBe(true);
    expect(result.fixtureEventIdsComplete).toBe(true);
  });

  test('archives only the exact completed 38-event, 380-fixture dataset', () => {
    expect(evaluateFplArchiveEligibility(readyFacts)).toMatchObject({
      eligible: true,
      reason: null,
    });
  });
});
