import { describe, expect, test } from 'bun:test';

import type { LivePublicationRead } from '../../src/cache/live-publication-v2';
import { syncLiveSnapshotV2 } from '../../src/services/live-snapshot-v2.service';

const season = { seasonId: 2026, seasonCode: '2627' } as const;

describe('Live Points and Live Matches shared observation', () => {
  test('starts provider observation before the durable Live Points read completes', async () => {
    let resolveDurable!: (value: LivePublicationRead | null) => void;
    const durable = new Promise<LivePublicationRead | null>((resolve) => {
      resolveDurable = resolve;
    });
    let eventLiveCalls = 0;
    let fixtureCalls = 0;

    const sync = syncLiveSnapshotV2(season, 2, {
      dependencies: {
        getEventLive: async () => {
          eventLiveCalls += 1;
          throw new Error('event-live unavailable');
        },
        getFixtures: async () => {
          fixtureCalls += 1;
          throw new Error('fixtures unavailable');
        },
        getExpectedFixtureIds: async () => {
          throw new Error('fixture identity unavailable');
        },
        getReferenceData: async () => {
          throw new Error('reference data unavailable');
        },
        readPublished: async () => null,
        readCheckpointed: async () => durable,
        checkpointPublication: async () => false,
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(eventLiveCalls).toBe(1);
    expect(fixtureCalls).toBe(1);

    resolveDurable(null);
    await expect(sync).rejects.toThrow('event-live unavailable');
  });

  test('publishes the score desk before event-live detail or identity fallback settles', async () => {
    let rejectEventLive!: (error: Error) => void;
    const eventLive = new Promise<never>((_resolve, reject) => {
      rejectEventLive = reject;
    });
    let rejectReference!: (error: Error) => void;
    const reference = new Promise<never>((_resolve, reject) => {
      rejectReference = reject;
    });
    const observations: Array<{
      rawEventLive: unknown;
      referenceData: unknown;
      finalizeEvent: boolean | undefined;
    }> = [];
    let resolveDeskPublished!: () => void;
    const deskPublished = new Promise<void>((resolve) => {
      resolveDeskPublished = resolve;
    });

    const sync = syncLiveSnapshotV2(season, 2, {
      finalizeEvent: true,
      dependencies: {
        getEventLive: async () => eventLive,
        getFixtures: async () => [],
        getExpectedFixtureIds: async () => [],
        getReferenceData: async () => reference,
        syncLiveMatches: async (observation) => {
          observations.push({
            rawEventLive: observation.rawEventLive,
            referenceData: observation.referenceData,
            finalizeEvent: observation.finalizeEvent,
          });
          resolveDeskPublished();
          return {} as never;
        },
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => false,
      },
    });

    await Promise.race([
      deskPublished,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('score desk waited for detail')), 100),
      ),
    ]);
    expect(observations).toEqual([
      { rawEventLive: undefined, referenceData: undefined, finalizeEvent: false },
    ]);

    rejectEventLive(new Error('event-live unavailable'));
    rejectReference(new Error('reference unavailable'));
    await expect(sync).rejects.toThrow('event-live unavailable');
  });

  test('publishes a first desk from fixtures and Core when event-live fails', async () => {
    const referenceData = { playerById: new Map() } as never;
    const observations: Array<{
      rawEventLive: unknown;
      referenceData: unknown;
      finalizeEvent: boolean | undefined;
      lifecycleState: string | undefined;
    }> = [];

    const sync = syncLiveSnapshotV2(season, 2, {
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      dependencies: {
        getEventLive: async () => {
          throw new Error('event-live unavailable');
        },
        getFixtures: async () => [],
        getExpectedFixtureIds: async () => [],
        getReferenceData: async () => referenceData,
        syncLiveMatches: async (observation) => {
          observations.push({
            rawEventLive: observation.rawEventLive,
            referenceData: observation.referenceData,
            finalizeEvent: observation.finalizeEvent,
            lifecycleState: observation.lifecycleState,
          });
          if (observation.referenceData === undefined) {
            throw new Error('first desk needs Core identity');
          }
          return {} as never;
        },
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => false,
      },
    });

    await expect(sync).rejects.toThrow('event-live unavailable');
    expect(observations).toEqual([
      {
        rawEventLive: undefined,
        referenceData: undefined,
        finalizeEvent: false,
        lifecycleState: 'GW_REVIEW',
      },
      {
        rawEventLive: undefined,
        referenceData,
        finalizeEvent: false,
        lifecycleState: 'GW_REVIEW',
      },
    ]);
  });

  test('hands the fixture-phase desk to the complete phase of the same observation', async () => {
    const desk = {
      publicationId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      season: season.seasonCode,
      eventId: 2,
    } as never;
    const earlyResult = {
      desk,
      deskFixtures: [],
      deskChanged: true,
      deskCheckpointScheduled: true,
    } as never;
    const publishedDesks: unknown[] = [];
    let calls = 0;
    const sync = syncLiveSnapshotV2(season, 2, {
      dependencies: {
        getEventLive: async () => ({ elements: [] }),
        getFixtures: async () => [],
        getExpectedFixtureIds: async () => [],
        getReferenceData: async () => ({ playerById: new Map() }) as never,
        syncLiveMatches: async (observation) => {
          calls += 1;
          publishedDesks.push(observation.publishedDesk);
          return earlyResult;
        },
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => false,
      },
    });

    await sync.catch(() => undefined);

    expect(calls).toBe(2);
    expect(publishedDesks[0]).toBeUndefined();
    expect(publishedDesks[1]).toEqual({
      publication: desk,
      fixtures: [],
      changed: true,
      checkpointScheduled: true,
    });
  });
});
