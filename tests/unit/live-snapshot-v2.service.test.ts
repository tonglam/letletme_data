import { describe, expect, test } from 'bun:test';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import type { LivePublicationRead } from '../../src/cache/live-publication-v2';
import type { LiveSnapshotReferenceData } from '../../src/services/live-coherent-fetch';
import { syncLiveSnapshotV2 } from '../../src/services/live-snapshot-v2.service';
import type { RawFPLFixture } from '../../src/types';

const season = { seasonId: 2026, seasonCode: '2627' } as const;

describe('Live Points and Live Matches shared observation', () => {
  test('consumes a supplied fixtures observation without refetching the provider', async () => {
    let fixtureCalls = 0;
    const sync = syncLiveSnapshotV2(season, 2, {
      observedFixtures: [],
      dependencies: {
        getEventLive: async () => {
          throw new Error('event-live unavailable');
        },
        getFixtures: async () => {
          fixtureCalls += 1;
          throw new Error('unexpected second fixtures observation');
        },
        getExpectedFixtureIds: async () => [],
        getReferenceData: async () => {
          throw new Error('reference data unavailable');
        },
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => false,
      },
    });

    await expect(sync).rejects.toThrow();
    expect(fixtureCalls).toBe(0);
  });

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
      observedActive: {
        observed: JSON.stringify(desk),
        read: {
          publication: desk,
          fixtures: [],
          servedFrom: 'REDIS_CURRENT',
        },
      },
    });
  });

  test('does not finalize the Match sibling before Live Points accepts exact facts', async () => {
    const finalizeFlags: boolean[] = [];
    const sync = syncLiveSnapshotV2(season, 2, {
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      dependencies: {
        getEventLive: async () => ({ elements: [] }),
        getFixtures: async () => [],
        getExpectedFixtureIds: async () => [],
        getReferenceData: async () =>
          ({ playerById: new Map(), playerTeamById: new Map() }) as never,
        syncLiveMatches: async (observation) => {
          finalizeFlags.push(observation.finalizeEvent === true);
          return {} as never;
        },
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => false,
      },
    });

    await expect(sync).rejects.toThrow('contains no elements');
    expect(finalizeFlags).toEqual([false, false]);
  });

  test('rejects a final Live Points publication when provisional Match detail is unavailable', async () => {
    const rawFixture: RawFPLFixture = {
      code: 10401,
      event: 2,
      finished: false,
      finished_provisional: false,
      id: 401,
      kickoff_time: '2026-08-29T10:00:00.000Z',
      minutes: 45,
      provisional_start_time: false,
      started: true,
      team_a: 20,
      team_a_score: 0,
      team_h: 10,
      team_h_score: 1,
      stats: [{ identifier: 'bps', h: [{ element: 101, value: 30 }], a: [] }],
      team_h_difficulty: 3,
      team_a_difficulty: 3,
      pulse_id: 401,
    };
    const sourceElement = rawExplainElementsFixture[0];
    if (!sourceElement) throw new Error('live snapshot fixture is missing');
    const referenceData: LiveSnapshotReferenceData = {
      season: season.seasonCode,
      nameById: new Map([
        [10, 'Home FC'],
        [20, 'Away FC'],
      ]),
      shortNameById: new Map([
        [10, 'HOM'],
        [20, 'AWA'],
      ]),
      positionById: new Map(),
      playerTeamById: new Map([[101, 10]]),
      playerById: new Map([
        [101, { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }],
      ]),
    };
    let checkpointCalls = 0;
    const sync = syncLiveSnapshotV2(season, 2, {
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      dependencies: {
        getEventLive: async () => ({ elements: [structuredClone(sourceElement)] }),
        getFixtures: async () => [rawFixture],
        getExpectedFixtureIds: async () => [401],
        getReferenceData: async () => referenceData,
        readObservedMatchDesk: async () => ({ observed: '', read: null }),
        syncLiveMatches: async () =>
          ({
            season: season.seasonCode,
            eventId: 2,
            state: 'LIVE_ACTIVE',
            desk: {} as never,
            deskFixtures: [{ fixtureId: 401 }] as never,
            detail: null,
            deskChanged: true,
            detailChanged: false,
            deskCheckpointScheduled: true,
            detailCheckpointScheduled: false,
            detailUnavailableReason: 'DETAIL_CANDIDATE_INVALID',
          }) as never,
        readPublished: async () => null,
        readCheckpointed: async () => null,
        checkpointPublication: async () => {
          checkpointCalls += 1;
          return false;
        },
      },
    });

    await expect(sync).rejects.toThrow('provisional detail is unavailable');
    expect(checkpointCalls).toBe(0);
  });
});
