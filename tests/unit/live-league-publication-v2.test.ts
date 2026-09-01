import { describe, expect, test } from 'bun:test';

import {
  liveLeagueV2ItemKey,
  parseLiveLeaguePublicationV2Manifest,
  type LeagueLiveManifest,
  type LeagueLiveScope,
} from '../../src/cache/live-league-publication-v2';

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
