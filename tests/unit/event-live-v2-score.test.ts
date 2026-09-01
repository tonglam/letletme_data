import { describe, expect, test } from 'bun:test';

import {
  eventLiveHeartbeatIsFresh,
  eventLivePicksAreFresh,
  eventLiveProjectedPicksAreCoherent,
  derivePreviousTotalsFromResultEvidence,
  hasCompleteAggregateCoverage,
} from '../../src/services/event-live-v2-score.service';
import { assistantManagerPointsFactFromProviderObservation } from '../../src/domain/event-live-manager-points';
import type { RawFPLEntryEventPicksResponse, RawFPLEventLiveResponse } from '../../src/types';

describe('Live Points V2 freshness boundaries', () => {
  test('treats provider heartbeat and entry picks as separate budgets', () => {
    const heartbeat = '2026-08-24T00:01:00.000Z';
    expect(eventLiveHeartbeatIsFresh(heartbeat, Date.parse(heartbeat) + 90_000)).toBe(true);
    expect(eventLiveHeartbeatIsFresh(heartbeat, Date.parse(heartbeat) + 90_001)).toBe(false);
    expect(eventLivePicksAreFresh('2026-08-24T00:00:00.000Z', heartbeat)).toBe(true);
    expect(eventLivePicksAreFresh('2026-08-23T23:44:59.000Z', heartbeat)).toBe(true);
  });

  test('allows a coherent older picks publication to remain usable', () => {
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-23T00:00:00.000Z', '2026-08-24T00:01:00.000Z'),
    ).toBe(true);
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-24T00:02:00.000Z', '2026-08-24T00:01:00.000Z'),
    ).toBe(false);
  });

  test('requires complete contiguous aggregate coverage', () => {
    expect(
      hasCompleteAggregateCoverage({ eventCount: 3, firstEventId: 2, lastEventId: 4 }, 2, 4),
    ).toBe(true);
    expect(
      hasCompleteAggregateCoverage({ eventCount: 2, firstEventId: 2, lastEventId: 4 }, 2, 4),
    ).toBe(false);
    expect(hasCompleteAggregateCoverage(undefined, 1, 1)).toBe(false);
  });

  test('derives a background capture baseline from canonical result evidence', () => {
    expect(
      derivePreviousTotalsFromResultEvidence(2, 3528563, 1, [
        { entryId: 3528563, eventId: 1, eventNetPoints: 29 },
      ]),
    ).toEqual({ totalPoints: 29, throughEventId: 1 });
    expect(
      derivePreviousTotalsFromResultEvidence(3, 3528563, 1, [
        { entryId: 3528563, eventId: 1, eventNetPoints: 29 },
      ]),
    ).toBeNull();
    expect(derivePreviousTotalsFromResultEvidence(2, 3528563, 2, [])).toEqual({
      totalPoints: 0,
      throughEventId: null,
    });
  });

  test('derives Assistant Manager points only from provider totals matching the authority', () => {
    const picks = {
      entry_history: { points: 17 },
      picks: [{ element: 7, multiplier: 1 }],
    } as unknown as RawFPLEntryEventPicksResponse;
    const providerLive = {
      elements: [{ id: 7, stats: { total_points: 9 } }],
    } as unknown as RawFPLEventLiveResponse;
    const observation = {
      eventLives: [{ elementId: 7, totalPoints: 9 }],
      publication: {
        publicationId: '00000000-0000-4000-8000-000000000001',
        generation: 4,
        revisions: { scoreCore: { revision: 'a'.repeat(64) } },
      },
    };

    expect(
      assistantManagerPointsFactFromProviderObservation(picks, providerLive, observation),
    ).toMatchObject({
      points: 8,
      livePublicationId: observation.publication.publicationId,
      liveGeneration: observation.publication.generation,
      liveScoreCoreRevision: observation.publication.revisions.scoreCore.revision,
    });
    expect(
      assistantManagerPointsFactFromProviderObservation(
        picks,
        {
          elements: [{ id: 7, stats: { total_points: 10 } }],
        } as unknown as RawFPLEventLiveResponse,
        observation,
      ),
    ).toBeNull();
  });
});
