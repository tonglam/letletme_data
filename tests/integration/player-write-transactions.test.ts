import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import * as singleton from '../../src/db/singleton';
import { playerRepository } from '../../src/repositories/players';
import { playerStatsRepository } from '../../src/repositories/player-stats';
import { singlePlayerStatFixture } from '../fixtures/player-stats.fixtures';
import { singleRawFPLElementFixture } from '../fixtures/player-values.fixtures';
import { createPlayerPricesSync } from '../../src/services/player-prices.service';

const season = { seasonId: 2090, seasonCode: '9091' };
const scope = 'data-core:players';
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
let previousCurrent: number[] = [];
beforeAll(async () => {
  previousCurrent = (await observer`SELECT season_id FROM fpl.seasons WHERE is_current`).map(
    (r) => r.season_id,
  );
  await observer`UPDATE fpl.seasons SET is_current=false WHERE is_current`;
  await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state,is_current)
    VALUES(2090,'9091','Player write fixture',2090,2091,'active',true)`;
  await observer`INSERT INTO fpl.events(season_id,event_id,name) VALUES(2090,2,'Fixture')`;
  await observer`INSERT INTO fpl.teams(season_id,team_id,code,name,short_name) VALUES(2090,1,1,'Fixture','FIX')`;
  await observer`INSERT INTO fpl.players(season_id,element_id,code,element_type,team_id,web_name,price)
    VALUES(2090,1,1,1,1,'Fixture',50)`;
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
});
afterEach(() => mock.restore());
afterAll(async () => {
  await observer`DELETE FROM fpl.player_event_snapshot_publications WHERE season_id=2090`;
  await observer`DELETE FROM fpl.player_event_snapshots WHERE season_id=2090`;
  await observer`DELETE FROM fpl.players WHERE season_id=2090`;
  await observer`DELETE FROM fpl.teams WHERE season_id=2090`;
  await observer`DELETE FROM fpl.events WHERE season_id=2090`;
  await observer`DELETE FROM fpl.seasons WHERE season_id=2090`;
  if (previousCurrent.length)
    await observer`UPDATE fpl.seasons SET is_current=true WHERE season_id IN ${observer(previousCurrent)}`;
  await observer.end();
});
async function observeLock() {
  await observer.begin(async (tx) => {
    await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
  });
}
function instrumentWriteScope() {
  const original = singleton.getDb;
  let locked = 0;
  spyOn(singleton, 'getDb').mockImplementation(async () => {
    if (singleton.databaseTransactionStorage.getStore()) {
      await expect(observeLock()).rejects.toMatchObject({ code: '55P03' });
      locked++;
    }
    return original();
  });
  return () => locked;
}

test('price write holds the shared core scope and commits before the cascade sees it', async () => {
  const locked = instrumentWriteScope();
  let queued = false;
  const row = {
    elementId: 1,
    value: 51,
    lastValue: 50,
    changeType: 'Rise',
    changeDate: '20260909',
    eventId: 2,
    elementType: 1,
  };
  const sync = createPlayerPricesSync({
    findByChangeDate: async () => [row] as never,
    findLatestForPlayerIds: async () => [row] as never,
    readOrderingTimestamp: async () => new Date('2026-09-09T00:00:00Z'),
    getBootstrap: async () => {
      expect(singleton.databaseTransactionStorage.getStore()).toBeUndefined();
      await observeLock();
      return {
        elements: [{ ...singleRawFPLElementFixture, id: 1 }],
        events: [{ id: 1, deadline_time: '2026-08-15T17:30:00Z' }],
      } as never;
    },
    updatePrices: playerRepository.updatePrices,
    enqueueCoreSnapshot: async () => {
      expect(singleton.databaseTransactionStorage.getStore()).toBeUndefined();
      await observeLock();
      const [saved] =
        await observer`SELECT price FROM fpl.players WHERE season_id=2090 AND element_id=1`;
      expect(saved!.price).toBe(51);
      queued = true;
      return { id: 'fixture' } as never;
    },
  });
  await expect(sync(season, '20260909')).resolves.toMatchObject({ count: 1 });
  expect(locked()).toBeGreaterThan(0);
  expect(queued).toBe(true);
});

test('stats publication uses the same short scope and releases it after commit', async () => {
  const locked = instrumentWriteScope();
  await expect(
    playerStatsRepository.replaceBatch(
      season,
      [{ ...singlePlayerStatFixture, elementId: 1, eventId: 2 }],
      { sourceCheckedAt: new Date() },
    ),
  ).resolves.toMatchObject({ count: 1 });
  expect(locked()).toBeGreaterThan(0);
  await observeLock();
  const rows =
    await observer`SELECT revision FROM fpl.player_event_snapshot_publications WHERE season_id=2090 AND event_id=2`;
  expect(rows).toHaveLength(1);
});

test('price and stats worker entries do not retain a transaction across provider work', async () => {
  const bullmq = await import('bullmq');
  const seasons = await import('../../src/services/season-scoped-job.service');
  const fences = await import('../../src/utils/scheduler-obligation-fence');
  const attempts = await import('../../src/utils/data-sync-attempt');
  const tracking = await import('../../src/utils/job-run-logger');
  const connections = await import('../../src/utils/queue');
  const prices = await import('../../src/services/player-prices.service');
  const stats = await import('../../src/services/player-stats.service');
  let processor: ((job: unknown) => Promise<unknown>) | undefined;
  const emitter = {
    on() {
      return this;
    },
  };
  spyOn(bullmq, 'Worker').mockImplementation(function (_name: unknown, callback: unknown) {
    processor = callback as typeof processor;
    return emitter;
  } as never);
  spyOn(bullmq, 'QueueEvents').mockImplementation(function () {
    return emitter;
  } as never);
  spyOn(connections, 'getQueueConnection').mockReturnValue({} as never);
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  spyOn(fences, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(attempts, 'runDataSyncAttempt').mockImplementation(async (_input, operation) =>
    operation(),
  );
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  const contexts: boolean[] = [];
  const provider = async () => {
    contexts.push(Boolean(singleton.databaseTransactionStorage.getStore()));
    await observeLock();
    return { count: 1, errors: 0, changeDate: '20260909', eventId: 2 };
  };
  spyOn(prices, 'syncPlayerPricesForDate').mockImplementation(provider);
  spyOn(stats, 'syncPlayerStatsForEvent').mockImplementation(provider);
  spyOn(stats, 'syncCurrentPlayerStats').mockImplementation(provider);
  const { createDataSyncWorker } = await import('../../src/workers/data-sync.worker');
  createDataSyncWorker();
  expect(processor).toBeDefined();
  for (const data of [
    { name: 'player-prices', eventId: 2 },
    { name: 'player-stats', eventId: 2 },
    { name: 'player-stats' },
  ]) {
    await processor!({
      id: 'fixture',
      name: data.name,
      queueName: 'data-sync',
      attemptsMade: 0,
      timestamp: Date.now(),
      data: { ...season, eventId: data.eventId, changeDate: '20260909', source: 'manual' },
    });
  }
  expect(contexts).toEqual([false, false, false]);
});
