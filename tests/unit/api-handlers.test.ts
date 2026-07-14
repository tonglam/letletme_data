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

const { eventsAPI } = await import('../../src/api/events.api');
const { jobsAPI } = await import('../../src/api/jobs.api');
const { entrySyncAPI } = await import('../../src/api/entry-sync.api');

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
