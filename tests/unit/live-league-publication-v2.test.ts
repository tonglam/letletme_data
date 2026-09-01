import { describe, expect, test } from 'bun:test';

import {
  liveLeagueV2ItemKey,
  parseLiveLeaguePublicationV2Manifest,
  type LeagueLiveManifest,
  type LeagueLiveRead,
  type LeagueLiveScope,
} from '../../src/cache/live-league-publication-v2';
import { liveLeagueCheckpointIsDue } from '../../src/services/live-league-checkpoint-v2.service';
import {
  isH2HTournamentPhaseActive,
  isTimestampAtOrAfter,
} from '../../src/services/live-league-publication-v2.service';

const scope: LeagueLiveScope = {
  season: '2627',
  eventId: 1,
  tournamentId: 3,
  scope: 'CLASSIC',
};

const revision = 'a'.repeat(64);

const manifest = (): LeagueLiveManifest => ({
  contractVersion: 'live-points-v2',
  publicationId: '00000000-0000-4000-8000-000000000001',
  generation: 1,
  season: scope.season,
  eventId: scope.eventId,
  tournamentId: scope.tournamentId,
  scope: scope.scope,
  state: 'LIVE_ACTIVE',
  globalRef: {
    publicationId: '00000000-0000-4000-8000-000000000002',
    generation: 7,
  },
  revisions: {
    roster: revision,
    scoreCore: revision,
    fixtureIdentity: revision,
    entryInputSet: revision,
    identity: revision,
    officialRank: revision,
    rules: revision,
    algorithm: revision,
    schedule: null,
    averageSide: null,
    content: revision,
  },
  times: {
    sourceCheckedAt: '2026-08-30T00:00:00.000Z',
    contentUpdatedAt: '2026-08-30T00:00:00.000Z',
    publishedAt: '2026-08-30T00:00:01.000Z',
    checkpointedAt: null,
    expectedNextCheckAt: '2026-08-30T00:00:30.000Z',
  },
  counts: { expected: 1, published: 1, ready: 1, noPicks: 0 },
  items: {
    index: {
      name: 'index',
      key: liveLeagueV2ItemKey(scope, 1, 'index'),
      type: 'string',
      count: 1,
      bytes: 2,
      sha256: revision,
    },
    payload: {
      name: 'payload',
      key: liveLeagueV2ItemKey(scope, 1, 'payload'),
      type: 'string',
      count: 1,
      bytes: 2,
      sha256: revision,
    },
  },
});

describe('Live League V2 manifest contract', () => {
  test('accepts a complete Classic publication with exact item keys', () => {
    const value = parseLiveLeaguePublicationV2Manifest(JSON.stringify(manifest()), scope);
    expect(value).toMatchObject({
      publicationId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      counts: { expected: 1, published: 1, ready: 1, noPicks: 0 },
    });
  });

  test('rejects a manifest that advertises a partial Classic candidate', () => {
    const partial = {
      ...manifest(),
      counts: { expected: 1, published: 0, ready: 0, noPicks: 0 },
    };
    expect(parseLiveLeaguePublicationV2Manifest(JSON.stringify(partial), scope)).toBeNull();
  });

  test('rejects an item descriptor that points outside its generation', () => {
    const invalid = {
      ...manifest(),
      items: {
        ...manifest().items,
        index: {
          ...manifest().items.index,
          key: liveLeagueV2ItemKey(scope, 2, 'index'),
        },
      },
    };
    expect(parseLiveLeaguePublicationV2Manifest(JSON.stringify(invalid), scope)).toBeNull();
  });

  test('rejects an invalid publication contract version', () => {
    const invalid = { ...manifest(), contractVersion: 'live-points-v1' };
    expect(parseLiveLeaguePublicationV2Manifest(JSON.stringify(invalid), scope)).toBeNull();
  });
});

describe('Live League V2 checkpoint cadence', () => {
  test('coalesces a new non-boundary publication until its due time', () => {
    const read = {
      publication: {
        ...manifest(),
        times: {
          ...manifest().times,
          checkpointedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        },
      },
      index: [],
      payload: {},
      servedFrom: 'REDIS_CURRENT',
    } as LeagueLiveRead;
    expect(
      liveLeagueCheckpointIsDue(read, false, new Date(Date.now() + 60_000).toISOString()),
    ).toBe(false);
    expect(liveLeagueCheckpointIsDue(read)).toBe(true);
  });
});

describe('Live League V2 H2H phase window', () => {
  test('does not block finalization before, between, or after configured phases', () => {
    const tournament = {
      groupStartedEventId: 1,
      groupEndedEventId: 10,
      knockoutStartedEventId: 13,
      knockoutEndedEventId: 14,
    };

    expect(isH2HTournamentPhaseActive(tournament, 0)).toBe(false);
    expect(isH2HTournamentPhaseActive(tournament, 5)).toBe(true);
    expect(isH2HTournamentPhaseActive(tournament, 11)).toBe(false);
    expect(isH2HTournamentPhaseActive(tournament, 13)).toBe(true);
    expect(isH2HTournamentPhaseActive(tournament, 15)).toBe(false);
  });

  test('keeps an unconfigured official schedule fail-closed', () => {
    expect(
      isH2HTournamentPhaseActive(
        {
          groupStartedEventId: null,
          groupEndedEventId: null,
          knockoutStartedEventId: null,
          knockoutEndedEventId: null,
        },
        6,
      ),
    ).toBe(true);
  });

  test('treats an open-ended phase start as active from the first event', () => {
    expect(
      isH2HTournamentPhaseActive(
        {
          groupStartedEventId: null,
          groupEndedEventId: 6,
          knockoutStartedEventId: null,
          knockoutEndedEventId: null,
        },
        6,
      ),
    ).toBe(true);
    expect(
      isH2HTournamentPhaseActive(
        {
          groupStartedEventId: null,
          groupEndedEventId: 6,
          knockoutStartedEventId: null,
          knockoutEndedEventId: null,
        },
        7,
      ),
    ).toBe(false);
  });
});

describe('Live League V2 finalization freshness fences', () => {
  test('accepts source evidence at or after the event finalization boundary', () => {
    const boundary = '2026-08-30T00:00:00.000Z';
    expect(isTimestampAtOrAfter(boundary, boundary)).toBe(true);
    expect(isTimestampAtOrAfter('2026-08-30T00:00:01.000Z', boundary)).toBe(true);
  });

  test('rejects stale, missing, and invalid source evidence', () => {
    const boundary = '2026-08-30T00:00:00.000Z';
    expect(isTimestampAtOrAfter('2026-08-29T23:59:59.000Z', boundary)).toBe(false);
    expect(isTimestampAtOrAfter(null, boundary)).toBe(false);
    expect(isTimestampAtOrAfter('not-a-time', boundary)).toBe(false);
  });
});
