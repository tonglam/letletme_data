import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  canFinalizeLiveMatchSeed,
  canSkipMissingDetailDuringSeed,
  hasCurrentMatchDeskSyncEvidence,
  parseLiveMatchSeedArguments,
} from '../../scripts/seed-live-matches-v3';
import { isValidLiveMatchDetailCheckpointPayloadV3 } from '../../src/cache/live-match-publication-v3';

describe('live match V3 cutover seed arguments', () => {
  it('requires execution, season, and either a target or finalized sweep', () => {
    expect(
      parseLiveMatchSeedArguments(['--execute', '--season', '2627', '--event-id', '2']),
    ).toEqual({ execute: true, allFinalized: false, season: '2627', eventId: 2 });
    expect(
      parseLiveMatchSeedArguments(['--execute', '--all-finalized', '--season', '2627']),
    ).toEqual({ execute: true, allFinalized: true, season: '2627', eventId: null });
  });

  it('rejects an unsafe or incomplete cutover scope', () => {
    expect(() => parseLiveMatchSeedArguments(['--season', '2627', '--event-id', '2'])).toThrow();
    expect(() => parseLiveMatchSeedArguments(['--execute', '--season', '2627'])).toThrow();
    expect(() =>
      parseLiveMatchSeedArguments([
        '--execute',
        '--all-finalized',
        '--event-id',
        '0',
        '--season',
        '2627',
      ]),
    ).toThrow();
    expect(() =>
      parseLiveMatchSeedArguments([
        '--execute',
        '--season',
        '2627',
        '--season',
        '2627',
        '--event-id',
        '2',
      ]),
    ).toThrow();
  });

  it('only skips missing detail for blank, pre-deadline, or between-fixtures scopes', () => {
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 0, state: 'LIVE_ACTIVE' })).toBe(true);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'PRE_DEADLINE' })).toBe(true);
    expect(
      canSkipMissingDetailDuringSeed(
        { fixtureCount: 2, state: 'LIVE_ACTIVE' },
        'BETWEEN_FIXTURES',
        true,
      ),
    ).toBe(true);
    expect(
      canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'LIVE_ACTIVE' }, 'BETWEEN_FIXTURES'),
    ).toBe(false);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'LIVE_ACTIVE' })).toBe(false);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'DAY_SETTLING' })).toBe(false);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'FINALIZED' })).toBe(false);
  });

  it('rejects case-insensitive duplicate stat identifiers in V3 detail payloads', () => {
    const valid = [
      {
        fixtureId: 1,
        players: [
          {
            id: 10,
            webName: 'Player',
            position: 3,
            teamId: 1,
            price: 50,
            totalPoints: 3,
            stats: [{ identifier: 'bps', value: 30, awardedPoints: 3 }],
          },
        ],
      },
    ];

    expect(isValidLiveMatchDetailCheckpointPayloadV3(valid)).toBe(true);
    expect(
      isValidLiveMatchDetailCheckpointPayloadV3([
        {
          ...valid[0]!,
          players: [
            {
              ...valid[0]!.players[0]!,
              stats: [
                { identifier: 'bps', value: 30, awardedPoints: 1 },
                { identifier: 'BPS', value: 30, awardedPoints: 2 },
              ],
            },
          ],
        },
      ]),
    ).toBe(false);
  });

  it('requires the current Match desk pointer to be refreshed before degradation', () => {
    const before = {
      servedFrom: 'REDIS_CURRENT' as const,
      publication: {
        publicationId: '00000000-0000-4000-8000-000000000001',
        generation: 1,
        sourceCheckedAt: '2026-08-31T14:00:00.000Z',
      },
    };
    expect(hasCurrentMatchDeskSyncEvidence(before, before)).toBe(false);
    expect(
      hasCurrentMatchDeskSyncEvidence(before, {
        ...before,
        publication: { ...before.publication, sourceCheckedAt: '2026-08-31T14:00:30.000Z' },
      }),
    ).toBe(true);
    expect(hasCurrentMatchDeskSyncEvidence(null, before)).toBe(true);
    expect(
      hasCurrentMatchDeskSyncEvidence(before, { ...before, servedFrom: 'REDIS_PREVIOUS' }),
    ).toBe(false);
  });

  it('requires the normal all-fixtures-finished finalization fence', () => {
    const event = {
      deadlineTime: '2026-08-29T10:00:00.000Z',
      finished: true,
      dataChecked: true,
      dataCheckedAt: new Date('2026-08-29T14:00:00.000Z'),
    } as const;
    const finishedFixture = {
      started: true,
      finished: true,
      finished_provisional: false,
      kickoff_time: '2026-08-29T10:00:00.000Z',
    } as const;
    expect(canFinalizeLiveMatchSeed(event, [finishedFixture])).toBe(true);
    expect(canFinalizeLiveMatchSeed(event, [{ ...finishedFixture, finished: false }])).toBe(false);
    expect(canFinalizeLiveMatchSeed({ ...event, dataCheckedAt: null }, [finishedFixture])).toBe(
      false,
    );
  });

  it('keeps the checked-in deploy helper on the same Match V3 seed path', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
    expect(deploy).toMatch(
      /bun run db:cutover-seed-live-match-v3 -- --execute --all-finalized[\s\S]*--season "\$LIVE_POINTS_V2_SEED_SEASON"[\s\S]*--event-id "\$LIVE_POINTS_V2_SEED_EVENT_ID"/,
    );
  });

  it('durably fences the desk before the price-bearing detail seed', () => {
    const source = readFileSync(
      new URL('../../scripts/seed-live-matches-v3.ts', import.meta.url),
      'utf8',
    );
    const deskCheckpoint = source.search(/kind: 'desk'/);
    const detailCheckpoint = source.search(/kind: 'detail'/);
    const missingDetailBranch = source.indexOf('if (!active)');
    expect(deskCheckpoint).toBeGreaterThan(-1);
    expect(detailCheckpoint).toBeGreaterThan(deskCheckpoint);
    expect(missingDetailBranch).toBeGreaterThan(deskCheckpoint);
    expect(source).toContain('readLiveMatchDeskPointerV3');
    expect(source).toContain('replaceFinalizedForCutover');
    expect(source).toContain('kind: ' + String.fromCharCode(39) + 'desk' + String.fromCharCode(39));
    expect(source).not.toContain('allowV2ReplacementForCutover');
  });

  it('uses one synchronized fixtures observation for finalization and sync', () => {
    const source = readFileSync(
      new URL('../../scripts/seed-live-matches-v3.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(
      /const observedFixtures = await fplClient\.getFixtures\(eventId\);[\s\S]*syncLiveSnapshotV2\([\s\S]*observedFixtures,/,
    );
  });

  it('bounds resource cleanup and exits the one-shot seed on every outcome', () => {
    const source = readFileSync(
      new URL('../../scripts/seed-live-matches-v3.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const SEED_CLEANUP_TIMEOUT_MS = 5_000;');
    expect(source).toContain('await closeSeedResources();');
    expect(source).toContain('closeLiveDataQueue()');
    expect(source).toContain('process.exit(exitCode);');
  });
});
