import { describe, expect, test } from 'bun:test';

import {
  assertLiveMatchesV2RepairAuthorization,
  assertLiveMatchesV2RepairSeason,
  LIVE_MATCHES_V2_REPAIR_CONFIRMATION,
  isLiveMatchDetailCompatibleWithDesk,
  parseLiveMatchesV2RepairRequest,
} from '../../src/services/live-match-v2-repair.service';

describe('Live Matches V2 repair guardrails', () => {
  test('rejects historical checkpoint replay before enqueueing it', () => {
    expect(() =>
      assertLiveMatchesV2RepairSeason('replay-checkpoint', { isCurrent: false }),
    ).toThrow('historical Live Matches checkpoint replay');
    expect(() =>
      assertLiveMatchesV2RepairSeason('replay-checkpoint', { isCurrent: true }),
    ).not.toThrow();
    expect(() =>
      assertLiveMatchesV2RepairSeason('rebuild-current', { isCurrent: false }),
    ).not.toThrow();
  });

  test('parses an exact read-only scope without write authorization', () => {
    expect(
      parseLiveMatchesV2RepairRequest({
        action: 'inspect',
        season: '2627',
        eventId: 2,
      }),
    ).toEqual({
      action: 'inspect',
      season: '2627',
      eventId: 2,
      kind: null,
      reason: null,
      confirmation: null,
    });
    expect(() =>
      assertLiveMatchesV2RepairAuthorization({ action: 'inspect', confirmation: null }),
    ).not.toThrow();
  });

  test('allows lagging provisional detail but requires an exact final desk pair', () => {
    const desk = {
      publication: {
        state: 'LIVE_ACTIVE',
        generation: 10,
        revisions: { fixtureIdentity: { revision: 'a'.repeat(64) } },
      },
    } as never;
    expect(
      isLiveMatchDetailCompatibleWithDesk(
        {
          publication: {
            finalized: false,
            observedDeskGeneration: 9,
            fixtureIdentityRevision: 'a'.repeat(64),
          },
        } as never,
        desk,
      ),
    ).toBe(true);
    expect(
      isLiveMatchDetailCompatibleWithDesk(
        {
          publication: {
            finalized: false,
            observedDeskGeneration: 11,
            fixtureIdentityRevision: 'a'.repeat(64),
          },
        } as never,
        desk,
      ),
    ).toBe(false);
    expect(
      isLiveMatchDetailCompatibleWithDesk(
        {
          publication: {
            finalized: true,
            observedDeskGeneration: 9,
            fixtureIdentityRevision: 'a'.repeat(64),
          },
        } as never,
        desk,
      ),
    ).toBe(false);
  });

  test('requires kind, reason, and explicit request confirmation for writes', () => {
    expect(() =>
      parseLiveMatchesV2RepairRequest({
        action: 'rebuild-current',
        season: '2627',
        eventId: 2,
        reason: 'checkpoint recovery',
      }),
    ).toThrow('exact desk or detail kind');
    expect(() =>
      parseLiveMatchesV2RepairRequest({
        action: 'rebuild-current',
        season: '2627',
        eventId: 2,
        kind: 'desk',
        reason: 'short',
      }),
    ).toThrow('at least 12 characters');
    expect(() =>
      assertLiveMatchesV2RepairAuthorization({ action: 'rebuild-current', confirmation: null }),
    ).toThrow(LIVE_MATCHES_V2_REPAIR_CONFIRMATION);
    expect(() =>
      assertLiveMatchesV2RepairAuthorization({
        action: 'rebuild-current',
        confirmation: LIVE_MATCHES_V2_REPAIR_CONFIRMATION,
      }),
    ).not.toThrow();
  });

  test('rejects unknown request fields instead of widening scope', () => {
    expect(() =>
      parseLiveMatchesV2RepairRequest({
        action: 'inspect',
        season: '2627',
        eventId: 2,
        allEvents: true,
      }),
    ).toThrow('Unsupported Live Matches repair field: allEvents');
    expect(() =>
      parseLiveMatchesV2RepairRequest({
        action: 'inspect',
        season: '2627',
        eventId: 0,
      }),
    ).toThrow('positive integer');
  });

  test('accepts a fully confirmed exact write request', () => {
    expect(
      parseLiveMatchesV2RepairRequest({
        action: 'replay-checkpoint',
        season: '2627',
        eventId: 2,
        kind: 'detail',
        reason: 'restore the retained detail checkpoint',
        confirmation: LIVE_MATCHES_V2_REPAIR_CONFIRMATION,
      }),
    ).toEqual({
      action: 'replay-checkpoint',
      season: '2627',
      eventId: 2,
      kind: 'detail',
      reason: 'restore the retained detail checkpoint',
      confirmation: LIVE_MATCHES_V2_REPAIR_CONFIRMATION,
    });
  });
});
