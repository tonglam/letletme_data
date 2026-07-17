import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const getCurrentEvent = mock(async () => ({ id: 20, name: 'Gameweek 20' }));
const getNextEvent = mock(async () => ({ id: 21, name: 'Gameweek 21' }));

mock.module('../../src/services/events.service', () => ({
  getCurrentEvent,
  getNextEvent,
}));

class JobNotFoundError extends Error {
  constructor(name: string) {
    super(`Job '${name}' not found`);
    this.name = 'JobNotFoundError';
  }
}

const listTriggerableJobs = mock(() => [
  { name: 'events-sync', description: 'Sync events from FPL API', schedule: 'Daily at 6:35 AM' },
]);
const triggerJob = mock(async (name: string) => {
  if (name === 'events-sync') {
    return { kind: 'enqueued' as const, jobId: 'job-events-1', message: 'Job triggered' };
  }
  throw new JobNotFoundError(name);
});
mock.module('../../src/services/job-trigger.service', () => ({
  JobNotFoundError,
  listTriggerableJobs,
  triggerJob,
}));

const enqueueEventsSyncJob = mock(async () => ({ id: 'events-job-1' }));
const enqueueFixturesSyncJob = mock(async () => ({ id: 'fixtures-job-1' }));
const enqueueFixturesAllGameweeksSyncJob = mock(async () => ({ id: 'fixtures-all-gw-job-1' }));
const enqueuePlayerStatsSyncJob = mock(async () => ({ id: 'player-stats-job-1' }));
mock.module('../../src/jobs/data-sync-enqueue', () => ({
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueueFixturesAllGameweeksSyncJob,
  enqueuePlayerStatsSyncJob,
}));

const enqueueEntryPicksSyncJob = mock(async () => ({ id: 'picks-job-1' }));
const enqueueEntryTransfersSyncJob = mock(async () => ({ id: 'transfers-job-1' }));
const enqueueEntryResultsSyncJob = mock(async () => ({ id: 'results-job-1' }));
mock.module('../../src/jobs/entry-sync-enqueue', () => ({
  enqueueEntryPicksSyncJob,
  enqueueEntryTransfersSyncJob,
  enqueueEntryResultsSyncJob,
}));

// Mock the live-data queue (not live-data.jobs) so real enqueue helpers run and
// unit suites stay isolated from manual-job-ids.test.ts which also exercises
// the real live-data.jobs module.
mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
    EVENT_LIVES_CACHE: 'event-lives-cache',
    EVENT_LIVES_DB: 'event-lives-db',
    EVENT_LIVE_SUMMARY: 'event-live-summary',
    EVENT_LIVE_EXPLAIN: 'event-live-explain',
    LIVE_FIXTURE_CACHE: 'live-fixture-cache',
    LIVE_BONUS_CACHE: 'live-bonus-cache',
    EVENT_OVERALL_RESULT: 'event-overall-result',
    LIVE_SCORES: 'live-scores',
  },
  getLiveDataQueue: () => ({
    name: 'live-data-p1',
    add: async (_name: string, _data: unknown, opts: { jobId?: string }) => ({
      id: opts.jobId ?? 'generated-live-id',
    }),
  }),
}));

// spyOn the real service (do not mock.module the whole file — that strips
// syncEventLives and breaks transaction-coverage.test.ts when suites share
// the mock registry).
const eventLivesService = await import('../../src/services/event-lives.service');
const getEventLivesByEventId = spyOn(
  eventLivesService,
  'getEventLivesByEventId',
).mockImplementation(async (eventId: number) => [{ elementId: 1, eventId }] as never);

const fixturesService = await import('../../src/services/fixtures.service');
const clearFixturesCache = spyOn(fixturesService, 'clearFixturesCache').mockImplementation(
  async () => undefined,
);

const checkTournamentNameAvailability = mock(async (name: string) => ({
  available: name !== 'taken',
  name,
}));
const getTournamentSetupStatus = mock(async () => null as null | Record<string, unknown>);
mock.module('../../src/services/tournament-create.service', () => ({
  checkTournamentNameAvailability,
  createTournament: mock(async () => ({})),
  getTournamentSetupStatus,
}));

const syncEntryInfo = mock(async (entryId: number) => ({ id: entryId, name: 'Test' }));
mock.module('../../src/services/entry-info.service', () => ({
  syncEntryInfo,
}));

const { eventsAPI } = await import('../../src/api/events.api');
const { jobsAPI } = await import('../../src/api/jobs.api');
const { entrySyncAPI } = await import('../../src/api/entry-sync.api');
const { fixturesAPI } = await import('../../src/api/fixtures.api');
const { playerStatsAPI } = await import('../../src/api/player-stats.api');
const { eventLivesAPI } = await import('../../src/api/event-lives.api');
const { tournamentsAPI } = await import('../../src/api/tournaments.api');
const { entryInfoAPI } = await import('../../src/api/entry-info.api');

describe('eventsAPI handlers', () => {
  beforeEach(() => {
    getCurrentEvent.mockClear();
    getNextEvent.mockClear();
    enqueueEventsSyncJob.mockClear();
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

  test('POST /events/sync enqueues the events sync job and returns 202', async () => {
    const response = await eventsAPI.handle(
      new Request('http://localhost/events/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('events-job-1');
    expect(enqueueEventsSyncJob).toHaveBeenCalledWith('api');
  });
});

describe('jobsAPI handlers', () => {
  beforeEach(() => {
    listTriggerableJobs.mockClear();
    triggerJob.mockClear();
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
    expect(listTriggerableJobs).toHaveBeenCalledTimes(1);
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
    expect(triggerJob).toHaveBeenCalledWith('events-sync');
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
    enqueueEntryPicksSyncJob.mockClear();
    enqueueEntryTransfersSyncJob.mockClear();
    enqueueEntryResultsSyncJob.mockClear();
  });

  test('POST /entry-sync/picks enqueues an entry-list job and returns 202', async () => {
    const response = await entrySyncAPI.handle(
      new Request('http://localhost/entry-sync/picks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: [1, 2], eventId: 20 }),
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('picks-job-1');
    expect(enqueueEntryPicksSyncJob).toHaveBeenCalledWith('api', {
      entryIds: [1, 2],
      eventId: 20,
    });
  });

  test('POST /entry-sync/all enqueues picks, transfers, and results jobs', async () => {
    const response = await entrySyncAPI.handle(
      new Request('http://localhost/entry-sync/all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryIds: [7] }),
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      success: boolean;
      jobIds: { picks: string; transfers: string; results: string };
    };
    expect(body.success).toBe(true);
    expect(body.jobIds).toEqual({
      picks: 'picks-job-1',
      transfers: 'transfers-job-1',
      results: 'results-job-1',
    });
    expect(enqueueEntryPicksSyncJob).toHaveBeenCalledWith('api', {
      entryIds: [7],
      eventId: undefined,
    });
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
    expect(enqueueEntryPicksSyncJob).not.toHaveBeenCalled();
  });
});

describe('fixturesAPI handlers', () => {
  beforeEach(() => {
    enqueueFixturesSyncJob.mockClear();
    enqueueFixturesAllGameweeksSyncJob.mockClear();
    clearFixturesCache.mockClear();
  });

  test('POST /fixtures/sync enqueues the fixtures job and returns 202', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('fixtures-job-1');
    expect(enqueueFixturesSyncJob).toHaveBeenCalledWith('api', {});
  });

  test('POST /fixtures/sync?event= coerces a numeric event filter', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync?event=12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueueFixturesSyncJob).toHaveBeenCalledWith('api', { eventId: 12 });
  });

  test('POST /fixtures/sync rejects a non-numeric event filter', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync?event=abc', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(enqueueFixturesSyncJob).not.toHaveBeenCalled();
  });

  test('POST /fixtures/sync-all-gameweeks enqueues the per-GW backfill and returns 202', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync-all-gameweeks', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueueFixturesAllGameweeksSyncJob).toHaveBeenCalledWith('api');
    expect(enqueueFixturesSyncJob).not.toHaveBeenCalled();
  });

  test('DELETE /fixtures/cache clears the cache', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/cache', { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(clearFixturesCache).toHaveBeenCalledTimes(1);
  });
});

describe('playerStatsAPI handlers', () => {
  beforeEach(() => {
    enqueuePlayerStatsSyncJob.mockClear();
  });

  test('POST /player-stats/sync enqueues the current sync and returns 202', async () => {
    const response = await playerStatsAPI.handle(
      new Request('http://localhost/player-stats/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueuePlayerStatsSyncJob).toHaveBeenCalledWith('api');
  });

  test('POST /player-stats/sync/:eventId enqueues with a numeric event id', async () => {
    const response = await playerStatsAPI.handle(
      new Request('http://localhost/player-stats/sync/15', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueuePlayerStatsSyncJob).toHaveBeenCalledWith('api', { eventId: 15 });
  });

  test('POST /player-stats/sync/:eventId rejects non-numeric ids', async () => {
    const response = await playerStatsAPI.handle(
      new Request('http://localhost/player-stats/sync/abc', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(enqueuePlayerStatsSyncJob).not.toHaveBeenCalled();
  });

  test('POST /player-stats/sync/:eventId rejects non-integer event ids', async () => {
    const response = await playerStatsAPI.handle(
      new Request('http://localhost/player-stats/sync/1.5', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(enqueuePlayerStatsSyncJob).not.toHaveBeenCalled();
  });
});

describe('eventLivesAPI handlers', () => {
  beforeEach(() => {
    getEventLivesByEventId.mockClear();
  });

  test('GET /event-lives/:eventId returns live data with a numeric event id', async () => {
    const response = await eventLivesAPI.handle(new Request('http://localhost/event-lives/12'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; eventId: number };
    expect(body.success).toBe(true);
    expect(body.eventId).toBe(12);
    expect(getEventLivesByEventId).toHaveBeenCalledWith(12);
  });

  test('GET /event-lives/:eventId rejects non-numeric ids', async () => {
    const response = await eventLivesAPI.handle(new Request('http://localhost/event-lives/abc'));
    expect(response.status).toBe(422);
    expect(getEventLivesByEventId).not.toHaveBeenCalled();
  });

  test('POST /event-lives/sync/:eventId enqueues the DB sync and returns 202', async () => {
    const response = await eventLivesAPI.handle(
      new Request('http://localhost/event-lives/sync/12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('event-lives-db-e12-manual');
  });

  test('POST /event-lives/cache/:eventId enqueues the cache update and returns 202', async () => {
    const response = await eventLivesAPI.handle(
      new Request('http://localhost/event-lives/cache/12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBe('event-lives-cache-e12-manual');
  });

  test('POST /event-lives/summary/:eventId enqueues the summary job and returns 202', async () => {
    const response = await eventLivesAPI.handle(
      new Request('http://localhost/event-lives/summary/12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string };
    expect(body.jobId).toBe('event-live-summary-e12-manual');
  });
});

describe('tournamentsAPI handlers', () => {
  beforeEach(() => {
    checkTournamentNameAvailability.mockClear();
    getTournamentSetupStatus.mockClear();
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

  test('GET /tournaments/check-name rejects an empty name', async () => {
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/check-name?name='),
    );
    expect(response.status).toBe(422);
    expect(checkTournamentNameAvailability).not.toHaveBeenCalled();
  });

  test('GET /tournaments/:id/setup-status omits the internal setupError field', async () => {
    getTournamentSetupStatus.mockImplementation(async () => ({
      setupStatus: 'failed',
      setupError: 'Connection terminated unexpectedly at internal-host:5432',
      setupStartedAt: '2026-07-17T01:00:00.000Z',
      setupFinishedAt: '2026-07-17T01:05:00.000Z',
    }));

    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/55/setup-status'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.setupStatus).toBe('failed');
    expect('setupError' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('internal-host');

    getTournamentSetupStatus.mockImplementation(async () => null);
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
