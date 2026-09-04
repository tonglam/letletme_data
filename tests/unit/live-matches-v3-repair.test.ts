import { describe, expect, test } from 'bun:test';

import {
  assertLiveMatchesV3RepairAuthorization,
  assertLiveMatchesV3RepairSeason,
  LIVE_MATCHES_V3_REPAIR_CONFIRMATION,
  isLiveMatchDetailCompatibleWithDesk,
  parseLiveMatchesV3RepairRequest,
  sameFinalLiveMatchDeskContent,
  sameFinalLiveMatchDetailContent,
  shouldPromoteLiveMatchActiveEvent,
} from '../../src/services/live-match-v3-repair.service';

describe('Live Matches V3 repair guardrails', () => {
  test('rejects historical checkpoint replay before enqueueing it', () => {
    expect(() =>
      assertLiveMatchesV3RepairSeason('replay-checkpoint', { isCurrent: false }),
    ).toThrow('historical Live Matches checkpoint replay');
    expect(() =>
      assertLiveMatchesV3RepairSeason('replay-checkpoint', { isCurrent: true }),
    ).not.toThrow();
    expect(() =>
      assertLiveMatchesV3RepairSeason('rebuild-current', { isCurrent: false }),
    ).not.toThrow();
  });

  test('uses the authoritative deadline instead of PRE_DEADLINE alone', () => {
    const now = new Date('2026-08-29T17:00:00.000Z');

    expect(shouldPromoteLiveMatchActiveEvent('LIVE_ACTIVE', null, now)).toBe(true);
    expect(shouldPromoteLiveMatchActiveEvent('PRE_DEADLINE', '2026-08-29T17:01:00.000Z', now)).toBe(
      false,
    );
    expect(shouldPromoteLiveMatchActiveEvent('PRE_DEADLINE', '2026-08-29T16:59:00.000Z', now)).toBe(
      true,
    );
    expect(shouldPromoteLiveMatchActiveEvent('PRE_DEADLINE', null, now)).toBe(false);
    expect(shouldPromoteLiveMatchActiveEvent('PRE_DEADLINE', 'not-a-date', now)).toBe(false);
  });

  test('parses an exact read-only scope without write authorization', () => {
    expect(
      parseLiveMatchesV3RepairRequest({
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
      assertLiveMatchesV3RepairAuthorization({ action: 'inspect', confirmation: null }),
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
      parseLiveMatchesV3RepairRequest({
        action: 'rebuild-current',
        season: '2627',
        eventId: 2,
        reason: 'checkpoint recovery',
      }),
    ).toThrow('exact desk or detail kind');
    expect(() =>
      parseLiveMatchesV3RepairRequest({
        action: 'rebuild-current',
        season: '2627',
        eventId: 2,
        kind: 'desk',
        reason: 'short',
      }),
    ).toThrow('at least 12 characters');
    expect(() =>
      assertLiveMatchesV3RepairAuthorization({ action: 'rebuild-current', confirmation: null }),
    ).toThrow(LIVE_MATCHES_V3_REPAIR_CONFIRMATION);
    expect(() =>
      assertLiveMatchesV3RepairAuthorization({
        action: 'rebuild-current',
        confirmation: LIVE_MATCHES_V3_REPAIR_CONFIRMATION,
      }),
    ).not.toThrow();
  });

  test('rejects unknown request fields instead of widening scope', () => {
    expect(() =>
      parseLiveMatchesV3RepairRequest({
        action: 'inspect',
        season: '2627',
        eventId: 2,
        allEvents: true,
      }),
    ).toThrow('Unsupported Live Matches repair field: allEvents');
    expect(() =>
      parseLiveMatchesV3RepairRequest({
        action: 'inspect',
        season: '2627',
        eventId: 0,
      }),
    ).toThrow('positive integer');
  });

  test('accepts a fully confirmed exact write request', () => {
    expect(
      parseLiveMatchesV3RepairRequest({
        action: 'replay-checkpoint',
        season: '2627',
        eventId: 2,
        kind: 'detail',
        reason: 'restore the retained detail checkpoint',
        confirmation: LIVE_MATCHES_V3_REPAIR_CONFIRMATION,
      }),
    ).toEqual({
      action: 'replay-checkpoint',
      season: '2627',
      eventId: 2,
      kind: 'detail',
      reason: 'restore the retained detail checkpoint',
      confirmation: LIVE_MATCHES_V3_REPAIR_CONFIRMATION,
    });
  });

  test('requires the pair recovery action to omit kind and still carry a reason', () => {
    expect(
      parseLiveMatchesV3RepairRequest({
        action: 'restore-equivalent-final-pair',
        season: '2627',
        eventId: 2,
        reason: 'restore the equivalent finalized pair',
      }),
    ).toMatchObject({
      action: 'restore-equivalent-final-pair',
      kind: null,
    });
    expect(() =>
      parseLiveMatchesV3RepairRequest({
        action: 'restore-equivalent-final-pair',
        season: '2627',
        eventId: 2,
        kind: null,
        reason: 'restore the equivalent finalized pair',
      }),
    ).toThrow('kind to be omitted');
    expect(() =>
      parseLiveMatchesV3RepairRequest({
        action: 'restore-equivalent-final-pair',
        season: '2627',
        eventId: 2,
      }),
    ).toThrow('reason with at least 12 characters');
  });

  test('compares final pair content while ignoring storage identity only', () => {
    const deskPublication = {
      season: '2627',
      eventId: 2,
      state: 'FINALIZED',
      desk: { sha256: 'a'.repeat(64), bytes: 12, count: 1 },
      revisions: {
        lifecycle: { revision: 'b'.repeat(64) },
        fixtureIdentity: { revision: 'c'.repeat(64) },
        scoreState: { revision: 'd'.repeat(64) },
      },
      publicationId: 'old',
      generation: 3,
    };
    const desk = { publication: deskPublication } as never;
    const equivalentDesk = {
      publication: {
        ...deskPublication,
        publicationId: 'new',
        generation: 9,
      },
    } as never;
    expect(sameFinalLiveMatchDeskContent(desk, equivalentDesk)).toBe(true);
    expect(
      sameFinalLiveMatchDeskContent(desk, {
        publication: {
          ...deskPublication,
          revisions: {
            ...deskPublication.revisions,
            scoreState: { revision: 'e'.repeat(64) },
          },
        },
      } as never),
    ).toBe(false);

    const detailFixtures = [
      { fixtureId: 20, count: 1, bytes: 20, sha256: '2'.repeat(64) },
      { fixtureId: 10, count: 1, bytes: 10, sha256: '1'.repeat(64) },
    ];
    const detailPublication = {
      season: '2627',
      eventId: 2,
      finalized: true,
      fixtureIdentityRevision: 'c'.repeat(64),
      detail: { revision: 'f'.repeat(64) },
      fixtures: detailFixtures,
      publicationId: 'old-detail',
      generation: 4,
    };
    const detail = {
      publication: {
        ...detailPublication,
      },
    } as never;
    const equivalentDetail = {
      publication: {
        ...detailPublication,
        publicationId: 'new-detail',
        generation: 8,
        fixtures: [...detailFixtures].reverse(),
      },
    } as never;
    expect(sameFinalLiveMatchDetailContent(detail, equivalentDetail)).toBe(true);
    expect(
      sameFinalLiveMatchDetailContent(detail, {
        publication: {
          ...detailPublication,
          detail: { revision: '0'.repeat(64) },
        },
      } as never),
    ).toBe(false);
  });
});
