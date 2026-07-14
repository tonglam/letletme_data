import { beforeEach, describe, expect, mock, test } from 'bun:test';

const getCurrentEvent = mock(async () => ({ id: 20, name: 'Gameweek 20' }));
const getNextEvent = mock(async () => ({ id: 21, name: 'Gameweek 21' }));
const syncEvents = mock(async () => ({ count: 38 }));

mock.module('../../src/services/events.service', () => ({
  getCurrentEvent,
  getNextEvent,
  syncEvents,
}));

const syncEntryEventPicks = mock(async (entryId: number) => ({ entryId, ok: true }));
const syncEntryEventTransfers = mock(async (entryId: number) => ({ entryId, ok: true }));
const syncEntryEventResults = mock(async (entryId: number) => ({ entryId, ok: true }));

mock.module('../../src/services/entries.service', () => ({
  syncEntryEventPicks,
  syncEntryEventTransfers,
  syncEntryEventResults,
}));

const enqueueEventsSyncJob = mock(async () => ({ id: 'job-events-1' }));
mock.module('../../src/jobs/data-sync-enqueue', () => ({
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob: mock(async () => ({ id: 'fixtures' })),
  enqueuePhasesSyncJob: mock(async () => ({ id: 'phases' })),
  enqueuePlayersSyncJob: mock(async () => ({ id: 'players' })),
  enqueuePlayerStatsSyncJob: mock(async () => ({ id: 'player-stats' })),
  enqueuePlayerValuesSyncJob: mock(async () => ({ id: 'player-values' })),
  enqueueTeamsSyncJob: mock(async () => ({ id: 'teams' })),
}));

const syncFixtures = mock(async () => ({ count: 10 }));
mock.module('../../src/services/fixtures.service', () => ({
  syncFixtures,
  syncAllGameweeks: mock(async () => ({ totalCount: 0, totalErrors: 0, perGameweek: [] })),
  clearFixturesCache: mock(async () => undefined),
}));

const checkTournamentNameAvailability = mock(async (name: string) => ({
  available: name !== 'taken',
  name,
}));
mock.module('../../src/services/tournament-create.service', () => ({
  checkTournamentNameAvailability,
  createTournament: mock(async () => ({})),
  getTournamentSetupStatus: mock(async () => null),
}));

const syncEntryInfo = mock(async (entryId: number) => ({ id: entryId, name: 'Test' }));
mock.module('../../src/services/entry-info.service', () => ({
  syncEntryInfo,
}));

const { eventsAPI } = await import('../../src/api/events.api');
const { jobsAPI } = await import('../../src/api/jobs.api');
const { entrySyncAPI } = await import('../../src/api/entry-sync.api');
const { fixturesAPI } = await import('../../src/api/fixtures.api');
const { tournamentsAPI } = await import('../../src/api/tournaments.api');
const { entryInfoAPI } = await import('../../src/api/entry-info.api');

describe('eventsAPI handlers', () => {
  beforeEach(() => {
    getCurrentEvent.mockClear();
    getNextEvent.mockClear();
    syncEvents.mockClear();
  });

  test('GET /events/current returns current event payload', async () => {
    const response = await eventsAPI.handle(new Request('http://localhost/events/current'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { id: number; name: string };
    };
    expect(body).toEqual({ success: true, data: { id: 20, name: 'Gameweek 20' } });
    expect(getCurrentEvent).toHaveBeenCalledTimes(1);
  });

  test('POST /events/sync triggers syncEvents', async () => {
    const response = await eventsAPI.handle(
      new Request('http://localhost/events/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(38);
    expect(syncEvents).toHaveBeenCalledTimes(1);
  });
});

describe('jobsAPI handlers', () => {
  beforeEach(() => {
    enqueueEventsSyncJob.mockClear();
  });

  test('GET /jobs lists available jobs', async () => {
    const response = await jobsAPI.handle(new Request('http://localhost/jobs/'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      jobs: Array<{ name: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.jobs.some((job) => job.name === 'events-sync')).toBe(true);
  });

  test('POST /jobs/events-sync/trigger enqueues the job', async () => {
    const response = await jobsAPI.handle(
      new Request('http://localhost/jobs/events-sync/trigger', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      jobId: string;
      message: string;
    };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('job-events-1');
    expect(enqueueEventsSyncJob).toHaveBeenCalledTimes(1);
  });

  test('POST /jobs/unknown/trigger returns 404', async () => {
    const response = await jobsAPI.handle(
      new Request('http://localhost/jobs/not-a-real-job/trigger', { method: 'POST' }),
    );
    expect(response.status).toBe(404);
  });
});

describe('entrySyncAPI handlers', () => {
  beforeEach(() => {
    syncEntryEventPicks.mockClear();
    syncEntryEventTransfers.mockClear();
    syncEntryEventResults.mockClear();
  });

  test('POST /entry-sync/picks syncs each entry id', async () => {
    const response = await entrySyncAPI.handle(
      new Request('http://localhost/entry-sync/picks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: [1, 2], eventId: 20 }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      processed: number;
      successCount: number;
    };
    expect(body.success).toBe(true);
    expect(body.processed).toBe(2);
    expect(body.successCount).toBe(2);
    expect(syncEntryEventPicks).toHaveBeenCalledTimes(2);
  });

  test('rejects entryIds arrays larger than 100', async () => {
    const response = await entrySyncAPI.handle(
      new Request('http://localhost/entry-sync/picks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: Array.from({ length: 101 }, (_, i) => i + 1) }),
      }),
    );
    expect(response.status).toBe(422);
  });
});

describe('fixturesAPI handlers', () => {
  beforeEach(() => {
    syncFixtures.mockClear();
  });

  test('POST /fixtures/sync triggers syncFixtures', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(10);
    expect(syncFixtures).toHaveBeenCalledTimes(1);
  });
});

describe('tournamentsAPI handlers', () => {
  beforeEach(() => {
    checkTournamentNameAvailability.mockClear();
  });

  test('GET /tournaments/check-name returns availability', async () => {
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/check-name?name=MyCup'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean; name: string };
    expect(body).toEqual({ available: true, name: 'MyCup' });
    expect(checkTournamentNameAvailability).toHaveBeenCalledWith('MyCup');
  });
});

describe('entryInfoAPI handlers', () => {
  beforeEach(() => {
    syncEntryInfo.mockClear();
  });

  test('POST /entry-info/:entryId/sync syncs a numeric entry id', async () => {
    const response = await entryInfoAPI.handle(
      new Request('http://localhost/entry-info/42/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { id: number } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(42);
    expect(syncEntryInfo).toHaveBeenCalledWith(42);
  });

  test('rejects non-numeric entryId params', async () => {
    const response = await entryInfoAPI.handle(
      new Request('http://localhost/entry-info/abc/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(syncEntryInfo).not.toHaveBeenCalled();
  });
});
