import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { TournamentSetupStatusRow } from '../../src/repositories/tournament-infos';

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
  {
    name: 'player-prices',
    description: 'Replay persisted price changes',
    schedule: 'Daily at 9:40 AM',
  },
]);
const triggerJob = mock(async (name: string, _input?: unknown) => {
  if (name === 'events-sync') {
    return { kind: 'enqueued' as const, jobId: 'job-events-1', message: 'Job triggered' };
  }
  if (name === 'player-prices') {
    return { kind: 'enqueued' as const, jobId: 'job-player-prices-1', message: 'Job triggered' };
  }
  throw new JobNotFoundError(name);
});
mock.module('../../src/services/job-trigger.service', () => ({
  JobNotFoundError,
  listTriggerableJobs,
  triggerJob,
}));

const enqueueEventsSyncJob = mock(async () => ({ id: 'events-job-1' }));
const enqueueCoreSnapshotJob = mock(async () => ({ id: 'core-snapshot-job-1' }));
const enqueuePlayersSyncJob = mock(async () => ({ id: 'players-job-1' }));
const enqueuePlayerValuesSyncJob = mock(async () => ({ id: 'player-values-job-1' }));
const enqueuePlayerStatsSyncJob = mock(async () => ({ id: 'player-stats-job-1' }));
const enqueueTeamsSyncJob = mock(async () => ({ id: 'teams-job-1' }));
const enqueuePhasesSyncJob = mock(async () => ({ id: 'phases-job-1' }));
mock.module('../../src/jobs/data-sync-enqueue', () => ({
  enqueueCoreSnapshotJob,
  enqueueEventsSyncJob,
  enqueuePlayersSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueueTeamsSyncJob,
  enqueuePhasesSyncJob,
}));

// Mock the entry-sync queue (not entry-sync-enqueue) so real enqueue helpers run.
// mock.module of entry-sync-enqueue pollutes entry-sync-enqueue.test.ts /
// manual-job-ids.test.ts when Bun shares the mock registry across files.
type EntrySyncAddCall = {
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
};
const entrySyncAddCalls: EntrySyncAddCall[] = [];
mock.module('../../src/queues/entry-sync.queue', () => ({
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE: 100,
  ENTRY_SYNC_DEFAULT_CONCURRENCY: 5,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS: 150,
  getEntrySyncQueue: () => ({
    name: 'entry-sync-p2',
    getJobs: async () => [],
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      entrySyncAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id', name, data };
    },
  }),
}));

// Mock the live-data queue (not live-data.jobs) so real enqueue helpers run and
// unit suites stay isolated from manual-job-ids.test.ts which also exercises
// the real live-data.jobs module.
mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
    LIVE_SNAPSHOT: 'live-snapshot',
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
  message: name,
}));
const getTournamentSetupStatus = mock(
  async (_tournamentId: number): Promise<TournamentSetupStatusRow | null> => null,
);
// Spy on only the two reads used here. Replacing this whole module leaks into
// tournament-create.test.ts when Bun executes unit files in one shared registry.
const tournamentCreateServiceModule = await import('../../src/services/tournament-create.service');
spyOn(tournamentCreateServiceModule, 'checkTournamentNameAvailability').mockImplementation(
  checkTournamentNameAvailability,
);
spyOn(tournamentCreateServiceModule, 'getTournamentSetupStatus').mockImplementation(
  getTournamentSetupStatus,
);

const managedTournament = {
  id: 55,
  name: 'Managed Cup',
  creator: 'Manager',
  adminEntryId: 123,
  totalTeamNum: 8,
  leagueType: 'classic' as const,
  groupMode: 'points_races' as const,
  groupNum: 1,
  knockoutMode: 'no_knockout' as const,
  rosterMode: 'snapshot' as const,
  state: 'active' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};
// Spy on the singleton instead of replacing the whole module. Bun shares the
// module mock registry across test files, and a partial mock here would hide
// createTournamentManagementService from tournament-management.test.ts.
const tournamentManagementServiceModule = await import(
  '../../src/services/tournament-management.service'
);
const updateTournament = spyOn(
  tournamentManagementServiceModule.tournamentManagementService,
  'updateTournament',
).mockImplementation(async () => managedTournament);
const deleteTournament = spyOn(
  tournamentManagementServiceModule.tournamentManagementService,
  'deleteTournament',
).mockImplementation(async () => managedTournament);

const { eventsAPI } = await import('../../src/api/events.api');
const { jobsAPI } = await import('../../src/api/jobs.api');
const { entrySyncAPI } = await import('../../src/api/entry-sync.api');
const { fixturesAPI } = await import('../../src/api/fixtures.api');
const { playersAPI } = await import('../../src/api/players.api');
const { playerValuesAPI } = await import('../../src/api/player-values.api');
const { playerStatsAPI } = await import('../../src/api/player-stats.api');
const { eventLivesAPI } = await import('../../src/api/event-lives.api');
const { tournamentsAPI } = await import('../../src/api/tournaments.api');
const { entryInfoAPI } = await import('../../src/api/entry-info.api');
const { teamsAPI } = await import('../../src/api/teams.api');
const { phasesAPI } = await import('../../src/api/phases.api');

describe('eventsAPI handlers', () => {
  beforeEach(() => {
    getCurrentEvent.mockClear();
    getNextEvent.mockClear();
    enqueueCoreSnapshotJob.mockClear();
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

  test('POST /events/sync enqueues the complete core snapshot and returns 202', async () => {
    const response = await eventsAPI.handle(
      new Request('http://localhost/events/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('core-snapshot-job-1');
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
  });
});

describe('playersAPI handlers', () => {
  test('POST /players/sync enqueues the complete core snapshot', async () => {
    const response = await playersAPI.handle(
      new Request('http://localhost/players/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, jobId: 'core-snapshot-job-1' });
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
  });
});

describe('playerValuesAPI handlers', () => {
  test('POST /player-values/sync enqueues the mutation-scoped job', async () => {
    const response = await playerValuesAPI.handle(
      new Request('http://localhost/player-values/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, jobId: 'player-values-job-1' });
    expect(enqueuePlayerValuesSyncJob).toHaveBeenCalledWith('api');
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
    expect(triggerJob).toHaveBeenCalledWith('events-sync', undefined);
  });

  test('POST /jobs/player-prices/trigger forwards the required change date', async () => {
    const response = await jobsAPI.handle(
      new Request('http://localhost/jobs/player-prices/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeDate: '20260803' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(triggerJob).toHaveBeenCalledWith('player-prices', { changeDate: '20260803' });
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
    entrySyncAddCalls.length = 0;
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
    expect(body.jobId).toMatch(/^entry-picks-entry-list-/);
    expect(entrySyncAddCalls).toHaveLength(1);
    expect(entrySyncAddCalls[0].name).toBe('entry-picks');
    expect(entrySyncAddCalls[0].data).toMatchObject({
      source: 'api',
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
    expect(body.jobIds.picks).toMatch(/^entry-picks-entry-list-/);
    expect(body.jobIds.transfers).toMatch(/^entry-transfers-entry-list-/);
    expect(body.jobIds.results).toMatch(/^entry-results-entry-list-/);
    expect(entrySyncAddCalls.map((c) => c.name).sort()).toEqual([
      'entry-picks',
      'entry-results',
      'entry-transfers',
    ]);
    for (const call of entrySyncAddCalls) {
      expect(call.data).toMatchObject({ source: 'api', entryIds: [7] });
    }
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
    expect(entrySyncAddCalls).toHaveLength(0);
  });
});

describe('fixturesAPI handlers', () => {
  beforeEach(() => {
    enqueueCoreSnapshotJob.mockClear();
    clearFixturesCache.mockClear();
  });

  test('POST /fixtures/sync enqueues the complete core snapshot and returns 202', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('core-snapshot-job-1');
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
  });

  test('POST /fixtures/sync?event= coerces a numeric event filter', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync?event=12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api', { eventId: 12 });
  });

  test('POST /fixtures/sync rejects a non-numeric event filter', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync?event=abc', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(enqueueCoreSnapshotJob).not.toHaveBeenCalled();
  });

  test('POST /fixtures/sync-all-gameweeks enqueues one complete core snapshot', async () => {
    const response = await fixturesAPI.handle(
      new Request('http://localhost/fixtures/sync-all-gameweeks', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
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

  test('POST /event-lives/sync/:eventId enqueues a persistent snapshot and returns 202', async () => {
    const response = await eventLivesAPI.handle(
      new Request('http://localhost/event-lives/sync/12', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { success: boolean; jobId: string };
    expect(body.success).toBe(true);
    expect(body.jobId).toBe('event-lives-db-e12-manual');
  });

  test('POST /event-lives/cache/:eventId enqueues a coherent snapshot and returns 202', async () => {
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
    updateTournament.mockClear();
    deleteTournament.mockClear();
    updateTournament.mockImplementation(async () => managedTournament);
    deleteTournament.mockImplementation(async () => managedTournament);
  });

  test('GET /tournaments/check-name returns availability', async () => {
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/check-name?name=MyCup'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean; message: string };
    expect(body).toEqual({ available: true, message: 'MyCup' });
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
      createdAt: '2026-07-17T00:59:00.000Z',
      setupStatus: 'failed',
      setupError: 'Connection terminated unexpectedly at internal-host:5432',
      setupPhase: 'failed',
      setupCompletedUnits: 17,
      setupTotalUnits: 75,
      setupProgressUpdatedAt: '2026-07-17T01:04:00.000Z',
      standingsReadyAt: null,
      setupWarningCount: 0,
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
    expect(body.setupPhase).toBe('failed');
    expect(body.setupCompletedUnits).toBe(17);
    expect(body.setupHasWarnings).toBe(false);
    expect('setupError' in body).toBe(false);
    expect('rosterSyncError' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('internal-host');

    getTournamentSetupStatus.mockImplementation(async () => null);
  });

  test('PATCH /tournaments/:id forwards a validated management command', async () => {
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/55', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Managed Cup', adminEntryId: 123 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, tournament: managedTournament });
    expect(updateTournament).toHaveBeenCalledWith(55, {
      name: 'Managed Cup',
      adminEntryId: 123,
    });
  });

  test('DELETE /tournaments/:id forwards ownership and returns a bounded receipt', async () => {
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/55', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminEntryId: 123 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      tournamentId: 55,
      deletedName: 'Managed Cup',
    });
    expect(deleteTournament).toHaveBeenCalledWith(55, { adminEntryId: 123 });
  });

  test('maps management ownership failures to 403', async () => {
    deleteTournament.mockImplementationOnce(async () => {
      throw Object.assign(
        new Error('Only the tournament administrator can delete this tournament.'),
        {
          status: 403,
        },
      );
    });
    const response = await tournamentsAPI.handle(
      new Request('http://localhost/tournaments/55', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ adminEntryId: 999 }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Only the tournament administrator can delete this tournament.',
    });
  });
});

describe('entryInfoAPI handlers', () => {
  beforeEach(() => {
    entrySyncAddCalls.length = 0;
  });

  test('POST /entry-info/:entryId/sync queues a numeric entry id', async () => {
    const response = await entryInfoAPI.handle(
      new Request('http://localhost/entry-info/42/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'queued',
      jobId: expect.any(String),
    });
    expect(entrySyncAddCalls).toHaveLength(1);
    expect(entrySyncAddCalls[0]).toMatchObject({
      name: 'entry-info',
      data: { source: 'api', entryIds: [42] },
    });
  });

  test('rejects non-numeric entryId params', async () => {
    const response = await entryInfoAPI.handle(
      new Request('http://localhost/entry-info/abc/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(422);
    expect(entrySyncAddCalls).toHaveLength(0);
  });
});

describe('queued core snapshot compatibility APIs', () => {
  beforeEach(() => {
    enqueueCoreSnapshotJob.mockClear();
  });

  test('POST /teams/sync returns the queued job contract', async () => {
    const response = await teamsAPI.handle(
      new Request('http://localhost/teams/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      status: 'queued',
      jobId: 'core-snapshot-job-1',
      message: 'Core snapshot queued',
    });
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
  });

  test('POST /phases/sync returns the queued job contract', async () => {
    const response = await phasesAPI.handle(
      new Request('http://localhost/phases/sync', { method: 'POST' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      status: 'queued',
      jobId: 'core-snapshot-job-1',
      message: 'Core snapshot queued',
    });
    expect(enqueueCoreSnapshotJob).toHaveBeenCalledWith('api');
  });
});
