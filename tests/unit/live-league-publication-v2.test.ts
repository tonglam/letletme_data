import { describe, expect, test } from 'bun:test';

import {
  liveLeagueV2ItemKey,
  leagueEntryInputRevision,
  parseLiveLeaguePublicationV2Manifest,
  validateLiveLeaguePublicationV2Checkpoint,
  type LeagueLiveManifest,
  type LeagueLiveRead,
  type LeagueLiveScope,
} from '../../src/cache/live-league-publication-v2';
import type { Exactly15Picks } from '../../src/cache/live-publication-v2';
import { canonicalJson, contentHash } from '../../src/utils/content-hash';
import {
  isLiveLeagueCheckpointGenerationCompatible,
  liveLeagueCheckpointIsDue,
} from '../../src/services/live-league-checkpoint-v2.service';
import {
  hasCompleteH2HOfficialScores,
  isH2HTournamentPhaseActive,
  isTimestampAtOrAfter,
  selectRetainedH2HMatchPayload,
} from '../../src/services/live-league-publication-v2.service';

const scope: LeagueLiveScope = {
  season: '2627',
  eventId: 1,
  tournamentId: 3,
  scope: 'CLASSIC',
};

const revision = 'a'.repeat(64);

function completeClassicCheckpointFixture() {
  const picks = Array.from({ length: 15 }, (_, index) => ({
    element: index + 1,
    position: index + 1,
    multiplier: index === 0 ? 2 : 1,
    isCaptain: index === 0,
    isViceCaptain: index === 1,
  })) as unknown as Exactly15Picks;
  const input = {
    contractVersion: 'live-points-v2' as const,
    season: scope.season,
    eventId: scope.eventId,
    entryId: 101,
    picksBase: {
      revision,
      contentUpdatedAt: '2026-08-30T00:00:00.000Z',
      picks,
      chip: null,
      reportedEventPoints: 42,
      transferCount: 0,
      transferCost: 0,
    },
    previousTotals: null,
    officialAdjustment: null,
    finalResult: {
      revision,
      score: { eventPoints: 42, totalPoints: 142 },
      picks,
      automaticSubs: [],
    },
  };
  const inputRevision = leagueEntryInputRevision(input);
  const index = [
    {
      entryId: input.entryId,
      availability: 'READY' as const,
      entryName: 'Entry 101',
      playerName: 'Player 101',
      region: null,
      startedEvent: null,
      overallPoints: 100,
      overallRank: 10,
      bank: 0,
      teamValue: 1000,
      totalTransfers: 0,
      lastEventId: null,
      lastOverallPoints: null,
      lastOverallRank: null,
      lastTeamValue: null,
      lastBank: null,
      inputPublicationId: '00000000-0000-4000-8000-000000000003',
      inputGeneration: 1,
      inputRevision,
      inputContentUpdatedAt: input.picksBase.contentUpdatedAt,
    },
  ];
  const payload = { [String(input.entryId)]: input };
  const indexPayload = canonicalJson(index);
  const payloadValue = canonicalJson(payload);
  const packed = { index, payload };
  const checkpointManifest: LeagueLiveManifest = {
    ...manifest(),
    state: 'FINALIZED',
    times: {
      ...manifest().times,
      checkpointedAt: '2026-08-30T00:00:02.000Z',
    },
    items: {
      index: {
        ...manifest().items.index,
        bytes: Buffer.byteLength(indexPayload, 'utf8'),
        sha256: contentHash(index),
      },
      payload: {
        ...manifest().items.payload,
        count: 1,
        bytes: Buffer.byteLength(payloadValue, 'utf8'),
        sha256: contentHash(payload),
      },
    },
  };
  return {
    checkpointManifest,
    index,
    payload,
    proof: {
      publicationId: checkpointManifest.publicationId,
      generation: checkpointManifest.generation,
      state: checkpointManifest.state,
      rowCount: index.length,
      payloadBytes: Buffer.byteLength(canonicalJson(packed), 'utf8'),
      payloadSha256: contentHash(packed),
    },
  };
}

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

  test('rejects a manifest with a missing nullable revision field', () => {
    const invalid = structuredClone(manifest()) as Record<string, unknown>;
    const revisions = { ...(invalid.revisions as Record<string, unknown>) };
    delete revisions.schedule;
    invalid.revisions = revisions;
    expect(parseLiveLeaguePublicationV2Manifest(JSON.stringify(invalid), scope)).toBeNull();
  });

  test('validates a finalized checkpoint beyond its FINALIZED state column', () => {
    const fixture = completeClassicCheckpointFixture();
    expect(
      validateLiveLeaguePublicationV2Checkpoint(
        scope,
        fixture.checkpointManifest,
        fixture.index,
        fixture.payload,
        fixture.proof,
      ),
    ).toBe(true);

    const corruptPayload = {
      ...fixture.payload,
      '999': fixture.payload['101'],
    };
    expect(
      validateLiveLeaguePublicationV2Checkpoint(
        scope,
        fixture.checkpointManifest,
        fixture.index,
        corruptPayload,
        fixture.proof,
      ),
    ).toBe(false);

    const incompletePayload = {
      ...fixture.payload,
      '101': {
        ...(fixture.payload['101'] as Record<string, unknown>),
        finalResult: null,
      },
    };
    expect(
      validateLiveLeaguePublicationV2Checkpoint(
        scope,
        fixture.checkpointManifest,
        fixture.index,
        incompletePayload,
        fixture.proof,
      ),
    ).toBe(false);
  });

  test('does not compare timestamps owned by different clocks', () => {
    const fixture = completeClassicCheckpointFixture();
    const skewedManifest = {
      ...fixture.checkpointManifest,
      times: {
        ...fixture.checkpointManifest.times,
        sourceCheckedAt: '2026-08-30T00:00:05.000Z',
        contentUpdatedAt: '2026-08-30T00:00:06.000Z',
        publishedAt: '2026-08-30T00:00:02.000Z',
        checkpointedAt: '2026-08-30T00:00:01.000Z',
      },
    };
    expect(
      validateLiveLeaguePublicationV2Checkpoint(
        scope,
        skewedManifest,
        fixture.index,
        fixture.payload,
        fixture.proof,
      ),
    ).toBe(true);
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

describe('Live League V2 checkpoint generation fence', () => {
  const candidate = { generation: 4, publicationId: 'candidate' };

  test('allows an idempotent retry for the same publication generation', () => {
    expect(
      isLiveLeagueCheckpointGenerationCompatible(
        { generation: 4, publicationId: 'candidate' },
        candidate,
      ),
    ).toBe(true);
  });

  test('rejects an identity conflict or an older candidate at the same scope', () => {
    expect(
      isLiveLeagueCheckpointGenerationCompatible(
        { generation: 4, publicationId: 'other' },
        candidate,
      ),
    ).toBe(false);
    expect(
      isLiveLeagueCheckpointGenerationCompatible(
        { generation: 5, publicationId: 'newer' },
        candidate,
      ),
    ).toBe(false);
    expect(
      isLiveLeagueCheckpointGenerationCompatible(
        { generation: 3, publicationId: 'older' },
        candidate,
      ),
    ).toBe(true);
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

describe('Live League V2 H2H final score fence', () => {
  test('requires an official score for every real side, including zero', () => {
    expect(hasCompleteH2HOfficialScores(101, 0, 202, 0)).toBe(true);
    expect(hasCompleteH2HOfficialScores(101, null, 202, 0)).toBe(false);
    expect(hasCompleteH2HOfficialScores(101, 0, 202, null)).toBe(false);
  });

  test('allows the missing score on a bye side with no entry', () => {
    expect(hasCompleteH2HOfficialScores(101, 42, null, null)).toBe(true);
  });

  test('does not require provider scores for a knockout bye', () => {
    expect(hasCompleteH2HOfficialScores(101, null, null, null, true)).toBe(true);
  });
});

describe('Live League V2 H2H match retention', () => {
  const payload = (state: 'READY' | 'PENDING' | 'ERROR') =>
    ({ state }) as Parameters<typeof selectRetainedH2HMatchPayload>[0] & {
      state: typeof state;
    };

  test('retains previous READY when active is a transient failure', () => {
    const active = payload('PENDING');
    const previous = payload('READY');

    expect(selectRetainedH2HMatchPayload(active, previous, payload('ERROR'))).toBe(previous);
  });

  test('uses active READY before previous READY', () => {
    const active = payload('READY');
    const previous = payload('READY');

    expect(selectRetainedH2HMatchPayload(active, previous, payload('ERROR'))).toBe(active);
  });
});
