import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const liveDataAddCalls: AddCall[] = [];
const entrySyncAddCalls: AddCall[] = [];
const tournamentSyncAddCalls: AddCall[] = [];
const leagueSyncAddCalls: AddCall[] = [];

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
    getJobs: async () => [],
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      liveDataAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

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

mock.module('../../src/queues/tournament-sync.queue', () => ({
  TOURNAMENT_JOBS: {
    EVENT_RESULTS: 'tournament-event-results',
    POINTS_RACE: 'tournament-points-race',
    BATTLE_RACE: 'tournament-battle-race',
    KNOCKOUT: 'tournament-knockout',
    TRANSFERS_POST: 'tournament-transfers-post',
    CUP_RESULTS: 'tournament-cup-results',
    SELECTION_STATS: 'tournament-selection-stats',
    MATERIALIZED_VIEWS_REFRESH: 'tournament-materialized-views-refresh',
    EVENT_PICKS: 'tournament-event-picks',
    TRANSFERS_PRE: 'tournament-transfers-pre',
    INFO: 'tournament-info',
  },
  getTournamentSyncQueue: () => ({
    name: 'tournament-sync-p2',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      tournamentSyncAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

mock.module('../../src/queues/league-sync.queue', () => ({
  LEAGUE_JOBS: {
    LEAGUE_EVENT_PICKS: 'league-event-picks',
    LEAGUE_EVENT_RESULTS: 'league-event-results',
  },
  getLeagueSyncQueue: () => ({
    name: 'league-sync-p3',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      leagueSyncAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

const { enqueueEventLivesDbSync, enqueueEventLivesCacheUpdate } = await import(
  '../../src/jobs/live-data.jobs'
);
const { enqueueEntryInfoSyncJob, enqueueEntryPicksSyncJob } = await import(
  '../../src/jobs/entry-sync-enqueue'
);
const { enqueueTournamentEventResults } = await import('../../src/jobs/tournament-sync.jobs');
const { enqueueLeagueEventResults } = await import('../../src/jobs/league-sync.jobs');
const { stableHash } = await import('../../src/utils/stable-hash');

describe('live-data manual job IDs', () => {
  beforeEach(() => {
    liveDataAddCalls.length = 0;
  });

  test('manual triggers get a deterministic per-(job, event) ID', async () => {
    const first = await enqueueEventLivesDbSync(10, 'manual');
    const second = await enqueueEventLivesDbSync(10, 'manual');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).toBe('event-lives-db-e10-manual');
    expect(second!.id).toBe('event-lives-db-e10-manual');
    // Repeat trigger hits BullMQ's jobId dedup instead of queueing duplicate work
    expect(liveDataAddCalls[1].opts.jobId).toBe('event-lives-db-e10-manual');
  });

  test('manual jobs clean up on settle so later re-triggers actually re-run', async () => {
    await enqueueEventLivesDbSync(10, 'manual');

    // Deterministic IDs dedupe across retained jobs too — without immediate cleanup,
    // a completed manual job would swallow re-triggers for the retention window.
    expect(liveDataAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(liveDataAddCalls[0].opts.removeOnFail).toBe(true);
  });

  test('manual IDs differ per job name and event', async () => {
    const dbSync = await enqueueEventLivesDbSync(10, 'manual');
    const cacheUpdate = await enqueueEventLivesCacheUpdate(10, 'manual');
    const otherEvent = await enqueueEventLivesDbSync(11, 'manual');

    expect(dbSync).not.toBeNull();
    expect(cacheUpdate).not.toBeNull();
    expect(otherEvent).not.toBeNull();
    expect(dbSync!.id).toBe('event-lives-db-e10-manual');
    expect(cacheUpdate!.id).toBe('event-lives-cache-e10-manual');
    expect(otherEvent!.id).toBe('event-lives-db-e11-manual');
  });

  test('cron runs keep time-based IDs so every tick enqueues', async () => {
    const job = await enqueueEventLivesDbSync(10, 'cron');

    expect(job).not.toBeNull();
    // Compatibility wire jobs use their own minute bucket; the waiting-room
    // check prevents a slow prior minute from stacking behind itself.
    expect(job!.id).toMatch(/^event-lives-db-e10-\d{12}$/);
    expect(job!.id).not.toBe('event-lives-db-e10-manual');
    // Cron jobs keep queue-level retention (no per-job cleanup override)
    expect(liveDataAddCalls[0].opts.removeOnComplete).toBeUndefined();
  });
});

describe('entry-sync entry-list job IDs', () => {
  beforeEach(() => {
    entrySyncAddCalls.length = 0;
  });

  test('entry-list jobs get a deterministic content-based ID', async () => {
    const first = await enqueueEntryPicksSyncJob('api', { entryIds: [3, 1, 2], eventId: 20 });
    const second = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2, 3], eventId: 20 });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).toMatch(/^entry-picks-entry-list-[0-9a-f]{8}$/);
    // Same entries in any order dedupe to the same job
    expect(second!.id).toBe(first!.id as string);
    // Entry-list jobs clean up on settle so repeat API calls after completion re-run
    expect(entrySyncAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(entrySyncAddCalls[0].opts.removeOnFail).toBe(true);
  });

  test('different entry lists or events produce different IDs', async () => {
    const base = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2], eventId: 20 });
    const otherIds = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2, 4], eventId: 20 });
    const otherEvent = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2], eventId: 21 });
    const noEvent = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2] });

    expect(base).not.toBeNull();
    expect(otherIds).not.toBeNull();
    expect(otherEvent).not.toBeNull();
    expect(noEvent).not.toBeNull();
    expect(otherIds!.id).not.toBe(base!.id as string);
    expect(otherEvent!.id).not.toBe(base!.id as string);
    expect(noEvent!.id).not.toBe(base!.id as string);
  });

  test('retryCount distinguishes delayed full-batch retries from the active job', async () => {
    const original = await enqueueEntryPicksSyncJob('api', {
      entryIds: [1, 2],
      eventId: 20,
    });
    const retry = await enqueueEntryPicksSyncJob('api', {
      entryIds: [1, 2],
      eventId: 20,
      retryCount: 1,
    });

    expect(original).not.toBeNull();
    expect(retry).not.toBeNull();
    expect(retry!.id).not.toBe(original!.id as string);
    expect(retry!.id).toMatch(/^entry-picks-entry-list-[0-9a-f]{8}$/);
  });

  test('cron chunk jobs keep time-based per-cycle IDs', async () => {
    const job = await enqueueEntryPicksSyncJob('cron', { chunkOffset: 0 });

    expect(job).not.toBeNull();
    expect(job!.id).toMatch(/^entry-picks-\d+-chunk-0$/);
  });

  test('manual table-scan chunk jobs get a deterministic ID with settle cleanup', async () => {
    const first = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });
    const second = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).toBe('entry-picks-manual-chunk-0');
    expect(second!.id).toBe(first!.id as string);
    expect(entrySyncAddCalls[0].data.runId).not.toBe('manual');
    expect(entrySyncAddCalls[1].data.runId).not.toBe(entrySyncAddCalls[0].data.runId);
    expect(entrySyncAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(entrySyncAddCalls[0].opts.removeOnFail).toBe(true);
  });

  test('an explicit daily root ID is removable so an incomplete chain can restart', async () => {
    const job = await enqueueEntryInfoSyncJob('cron', {
      eventId: 10,
      runId: 'daily-20260804',
      jobId: 'entry-info-daily-20260804',
      removeOnSettle: true,
    });

    expect(job.id).toBe('entry-info-daily-20260804');
    expect(entrySyncAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(entrySyncAddCalls[0].opts.removeOnFail).toBe(true);
  });
});

describe('deterministic result job retention', () => {
  beforeEach(() => {
    tournamentSyncAddCalls.length = 0;
    leagueSyncAddCalls.length = 0;
  });

  test('retains successful jobs for dedupe but removes failed jobs for cron retry', async () => {
    await enqueueTournamentEventResults(12, 'cron', {
      jobId: 'tournament-event-results-e12-final-10',
    });
    await enqueueLeagueEventResults(12, 'cron', {
      jobId: 'league-event-results-e12-coordinator-final-10',
    });

    for (const call of [tournamentSyncAddCalls[0], leagueSyncAddCalls[0]]) {
      expect(call.opts.removeOnComplete).toEqual({ age: 86_400 });
      expect(call.opts.removeOnFail).toBe(true);
    }
  });

  test('preserves a coordinator correlation ID in league child job data', async () => {
    await enqueueLeagueEventResults(12, 'cascade', {
      tournamentId: 42,
      runId: 'league-run-42',
    });

    expect(leagueSyncAddCalls[0].data.runId).toBe('league-run-42');
  });
});

describe('stableHash', () => {
  test('is deterministic and returns 8 hex chars', () => {
    expect(stableHash('1,2,3|e20')).toBe(stableHash('1,2,3|e20'));
    expect(stableHash('1,2,3|e20')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('differs on different inputs', () => {
    expect(stableHash('1,2,3|e20')).not.toBe(stableHash('1,2,4|e20'));
    expect(stableHash('')).not.toBe(stableHash('1'));
  });
});
