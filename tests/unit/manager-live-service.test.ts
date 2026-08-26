import { describe, expect, spyOn, test } from 'bun:test';

import {
  mergeClassicStandingWithEntrySummary,
  MANAGER_LIVE_READ_THROUGH_BACKGROUND_STANDINGS_PAGE_LIMIT,
  persistTournamentCoverage,
  projectEventLiveManagerRows,
  type ManagerLiveScoreRow,
} from '../../src/services/manager-live.service';
import { managerLiveTournamentCoverageRepository } from '../../src/repositories/live-window';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const row = (overrides: Partial<ManagerLiveScoreRow> = {}): ManagerLiveScoreRow => ({
  season: '2627',
  eventId: 1,
  entryId: 109967,
  eventPoints: 23,
  netEventPoints: null,
  totalPoints: 23,
  totalScope: 'CLASSIC_PHASE',
  eventRank: null,
  overallRank: 4_088_920,
  leagueRank: 84,
  source: 'FPL_CLASSIC_STANDINGS',
  transferCost: null,
  eventPointSemantics: 'UNKNOWN',
  revision: 'classic-revision',
  checkedAt: '2026-08-23T12:34:15.000Z',
  upstreamUpdatedAt: '2026-08-23T12:33:36.000Z',
  staleAt: '2026-08-23T12:35:45.000Z',
  ...overrides,
});

describe('Classic manager headline projection', () => {
  test('keeps read-through background standings bounded to the worker page budget', () => {
    expect(MANAGER_LIVE_READ_THROUGH_BACKGROUND_STANDINGS_PAGE_LIMIT).toBe(2);
  });

  test('does not report finalized coverage as published when the upsert fails', async () => {
    const findCoverage = spyOn(
      managerLiveTournamentCoverageRepository,
      'findByTournamentAndEvent',
    ).mockResolvedValue(null);
    const upsertCoverage = spyOn(
      managerLiveTournamentCoverageRepository,
      'upsert',
    ).mockRejectedValue(new Error('coverage database unavailable'));

    try {
      await expect(
        persistTournamentCoverage({
          season: TEST_SEASON,
          eventId: 1,
          tournamentId: 7,
          rosterRevision: 'roster-1',
          expectedEntries: 1,
          rows: [row({ source: 'FPL_FINAL_RESULT' })],
          errorCode: null,
          managerRevision: 'final:manager-1',
          crawlComplete: true,
        }),
      ).resolves.toBeNull();
    } finally {
      findCoverage.mockRestore();
      upsertCoverage.mockRestore();
    }
  });

  test('does not report finalized coverage as published when the roster fence rejects it', async () => {
    const findCoverage = spyOn(
      managerLiveTournamentCoverageRepository,
      'findByTournamentAndEvent',
    ).mockResolvedValue(null);
    const upsertCoverage = spyOn(
      managerLiveTournamentCoverageRepository,
      'upsert',
    ).mockResolvedValue(false);

    try {
      await expect(
        persistTournamentCoverage({
          season: TEST_SEASON,
          eventId: 1,
          tournamentId: 7,
          rosterRevision: 'roster-1',
          expectedEntries: 1,
          rows: [row({ source: 'FPL_FINAL_RESULT' })],
          errorCode: null,
          managerRevision: 'final:manager-1',
          crawlComplete: true,
        }),
      ).resolves.toBeNull();
    } finally {
      findCoverage.mockRestore();
      upsertCoverage.mockRestore();
    }
  });

  test('replaces a lagging 23-point summary with the traced 37-point event-live score', () => {
    const projected = projectEventLiveManagerRows(
      '2627',
      1,
      [109967],
      [
        row({
          checkedAt: '2026-08-24T00:00:50.000Z',
          staleAt: '2026-08-24T00:02:20.000Z',
        }),
      ],
      {
        season: '2627',
        eventId: 1,
        state: 'live',
        revision: 'fpl:live:publication-8:8',
        publicationId: 'publication-8',
        checkedAt: '2026-08-24T00:01:00.000Z',
        sourceCheckedAt: '2026-08-24T00:00:59.000Z',
        scores: new Map([
          [
            109967,
            {
              entryId: 109967,
              eventPoints: 37,
              netEventPoints: 37,
              transferCost: 0,
              totalPoints: 37,
              picksCheckedAt: '2026-08-24T00:00:30.000Z',
              revision: 'fpl:live:publication-8:8:entry:109967:score',
            },
          ],
        ]),
      },
    );

    expect(projected).toEqual([
      expect.objectContaining({
        entryId: 109967,
        eventPoints: 37,
        netEventPoints: 37,
        totalPoints: 37,
        source: 'FPL_EVENT_LIVE',
        leagueRank: 84,
        checkedAt: '2026-08-24T00:01:00.000Z',
      }),
    ]);
    expect(projected[0]?.revision).toStartWith(
      'fpl:live:publication-8:8:entry:109967:score:metadata:',
    );
  });

  test('does not stamp stale rank metadata with the fresh event-live timestamp', () => {
    const projected = projectEventLiveManagerRows('2627', 1, [109967], [row()], {
      season: '2627',
      eventId: 1,
      state: 'live',
      revision: 'fpl:live:publication-8:8',
      publicationId: 'publication-8',
      checkedAt: '2026-08-24T00:01:00.000Z',
      sourceCheckedAt: '2026-08-24T00:00:59.000Z',
      scores: new Map([
        [
          109967,
          {
            entryId: 109967,
            eventPoints: 37,
            netEventPoints: 37,
            transferCost: 0,
            totalPoints: 37,
            picksCheckedAt: '2026-08-24T00:00:30.000Z',
            revision: 'fpl:live:publication-8:8:entry:109967:score',
          },
        ],
      ]),
    });

    expect(projected[0]).toMatchObject({
      eventPoints: 37,
      eventRank: null,
      overallRank: null,
      leagueRank: null,
      checkedAt: '2026-08-24T00:01:00.000Z',
    });
  });

  test('changes the projected row revision when fresh rank metadata changes', () => {
    const batch = {
      season: '2627',
      eventId: 1,
      state: 'live' as const,
      revision: 'fpl:live:publication-8:8',
      publicationId: 'publication-8',
      checkedAt: '2026-08-24T00:01:00.000Z',
      sourceCheckedAt: '2026-08-24T00:00:59.000Z',
      scores: new Map([
        [
          109967,
          {
            entryId: 109967,
            eventPoints: 37,
            netEventPoints: 37,
            transferCost: 0,
            totalPoints: 37,
            picksCheckedAt: '2026-08-24T00:00:30.000Z',
            revision: 'fpl:live:publication-8:8:entry:109967:score',
          },
        ],
      ]),
    };
    const metadata = row({
      checkedAt: '2026-08-24T00:00:50.000Z',
      staleAt: '2026-08-24T00:02:20.000Z',
    });
    const first = projectEventLiveManagerRows('2627', 1, [109967], [metadata], batch);
    const changed = projectEventLiveManagerRows(
      '2627',
      1,
      [109967],
      [{ ...metadata, leagueRank: 83, revision: 'classic-revision-2' }],
      batch,
    );

    expect(changed[0]?.revision).not.toBe(first[0]?.revision);
  });

  test('uses the newer Entry Summary headline while retaining Classic league rank', () => {
    const projected = mergeClassicStandingWithEntrySummary(
      row(),
      row({
        eventPoints: 29,
        totalPoints: 29,
        totalScope: 'OVERALL',
        eventRank: 2_074_195,
        overallRank: 2_074_195,
        leagueRank: null,
        source: 'FPL_ENTRY_SUMMARY',
        revision: 'summary-revision',
        checkedAt: '2026-08-23T14:54:20.000Z',
        upstreamUpdatedAt: null,
        staleAt: '2026-08-23T14:55:50.000Z',
      }),
    );

    expect(projected).toMatchObject({
      eventPoints: 29,
      totalPoints: 29,
      totalScope: 'OVERALL',
      eventRank: 2_074_195,
      overallRank: 2_074_195,
      leagueRank: 84,
      source: 'FPL_ENTRY_SUMMARY',
    });
    expect(projected).toMatchObject({
      checkedAt: '2026-08-23T12:34:15.000Z',
      staleAt: '2026-08-23T12:35:45.000Z',
    });
    expect(projected?.revision).not.toBe('classic-revision');
  });

  test('does not replace a newer Classic observation with an older summary', () => {
    const projected = mergeClassicStandingWithEntrySummary(
      row({
        checkedAt: '2026-08-23T14:54:20.000Z',
        upstreamUpdatedAt: '2026-08-23T12:34:30.000Z',
        eventPoints: 37,
        totalPoints: 37,
      }),
      row({
        eventPoints: 29,
        totalPoints: 29,
        totalScope: 'OVERALL',
        source: 'FPL_ENTRY_SUMMARY',
        checkedAt: '2026-08-23T12:34:15.000Z',
        upstreamUpdatedAt: null,
      }),
    );

    expect(projected).toMatchObject({
      eventPoints: 37,
      totalPoints: 37,
      source: 'FPL_CLASSIC_STANDINGS',
      leagueRank: 84,
    });
  });

  test('converges a newer Entry Summary over a missing-standings fallback', () => {
    const projected = mergeClassicStandingWithEntrySummary(
      row({
        eventPoints: 23,
        totalPoints: 23,
        totalScope: 'OVERALL',
        overallRank: null,
        leagueRank: null,
        source: 'FPL_ENTRY_SUMMARY',
        revision: 'old-summary-revision',
        checkedAt: '2026-08-23T12:34:15.000Z',
        upstreamUpdatedAt: null,
        staleAt: '2026-08-23T12:35:45.000Z',
      }),
      row({
        eventPoints: 29,
        totalPoints: 29,
        totalScope: 'OVERALL',
        overallRank: 2_074_195,
        leagueRank: null,
        source: 'FPL_ENTRY_SUMMARY',
        revision: 'new-summary-revision',
        checkedAt: '2026-08-23T12:34:16.000Z',
        upstreamUpdatedAt: null,
        staleAt: '2026-08-23T12:35:46.000Z',
      }),
    );

    expect(projected).toMatchObject({
      eventPoints: 29,
      totalPoints: 29,
      source: 'FPL_ENTRY_SUMMARY',
      leagueRank: null,
      overallRank: 2_074_195,
    });
    expect(projected?.revision).not.toBe('old-summary-revision');
  });
});
