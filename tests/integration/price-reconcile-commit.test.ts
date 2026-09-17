import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import * as singleton from '../../src/db/singleton';
import * as price from '../../src/services/price-change-predictions.service';
import * as hot from '../../src/services/price-change-hot.service';
import * as scheduler from '../../src/scheduler/scheduler.service';
import * as lanes from '../../src/repositories/scheduler-lanes';
import * as delivery from '../../src/services/data-publication-delivery.service';
import * as cache from '../../src/cache/data-publication';
import { syncOperationsRepository } from '../../src/repositories/sync-operations';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
const marker = 'integration:price-postcommit-handoff';
const processors = new Map<string, (job: unknown) => Promise<unknown>>();
const seen: Array<{ transaction: boolean; committed: boolean }> = [];
let failEnqueue = false;
let previousFlag: string | undefined;
const prepared = {
  outcome: 'ready',
  season: TEST_SEASON,
  sourceRunId: '00000000-0000-4000-8000-000000000301',
  board: { players: [], revision: 'fixture-board', latestEvent: null },
} as unknown as price.PreparedPriceChangePublication;
const result = {
  outcome: 'ready',
  publicationId: '00000000-0000-4000-8000-000000000302',
  revision: 1,
  players: 0,
  season: TEST_SEASON.seasonCode,
} as price.PriceChangeSyncResult;
const newer = { event: {}, revision: 'new-hot' } as price.PriceChangeHotEventEvidence;
beforeEach(async () => {
  await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${marker}`;
  previousFlag = process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED;
  process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED = 'true';
  seen.length = 0;
  failEnqueue = false;
  const bullmq = await import('bullmq');
  const queue = await import('../../src/utils/queue');
  const seasons = await import('../../src/services/season-scoped-job.service');
  const fences = await import('../../src/utils/scheduler-obligation-fence');
  const attempts = await import('../../src/utils/data-sync-attempt');
  const tracking = await import('../../src/utils/job-run-logger');
  const emitter = {
    on() {
      return this;
    },
  };
  spyOn(bullmq, 'Worker').mockImplementation(function (name: string, fn: unknown) {
    processors.set(name, fn as never);
    return emitter;
  } as never);
  spyOn(bullmq, 'QueueEvents').mockImplementation(function () {
    return emitter;
  } as never);
  spyOn(queue, 'getQueueConnection').mockReturnValue({} as never);
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(TEST_SEASON);
  spyOn(fences, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(attempts, 'runDataSyncAttempt').mockImplementation(async (_input, operation) =>
    operation(),
  );
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  spyOn(price, 'preparePriceChangePublication').mockResolvedValue(prepared);
  spyOn(hot, 'readPriceChangeHotSnapshot').mockResolvedValue(null);
  spyOn(hot, 'priceChangeHotEventEvidence').mockReturnValue(newer);
  spyOn(price, 'persistPriceChangePublication').mockImplementation(async (_prepared, options) => {
    expect(singleton.databaseTransactionStorage.getStore()).toBeDefined();
    const tx = await singleton.getDbClient();
    await tx`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${marker},clock_timestamp()) ON CONFLICT(scope_key) DO UPDATE SET last_used_at=excluded.last_used_at`;
    // Model the former post-activation callback contract. Calling it here must
    // never enqueue under the parent transaction, even with deferred Redis delivery.
    const legacy = options as {
      onHotEventSuperseded?: (event: price.PriceChangeHotEventEvidence) => Promise<void>;
    };
    if (legacy.onHotEventSuperseded) await legacy.onHotEventSuperseded(newer);
    return result;
  });
  spyOn(scheduler, 'triggerPriceChangeLane').mockImplementation(async () => {
    const [saved] =
      await observer`SELECT count(*)::int AS count FROM ops.mutation_scopes WHERE scope_key=${marker}`;
    seen.push({
      transaction: Boolean(singleton.databaseTransactionStorage.getStore()),
      committed: saved!.count === 1,
    });
    if (failEnqueue) throw new Error('queue handoff unavailable');
    return { state: 'enqueued', bullJobId: 'fixture' };
  });
  spyOn(delivery, 'dispatchDataPublicationOutbox').mockResolvedValue({ delivered: 1 } as never);
  spyOn(cache, 'readActiveDataPublication').mockResolvedValue({
    manifest: { publicationId: result.publicationId, revision: 1 },
  } as never);
  spyOn(syncOperationsRepository, 'failRun').mockResolvedValue(undefined);
  const target = {
    lane: { laneId: 'fixture-lane', state: 'running', activeObligationId: 'fixture-obligation' },
    obligation: { obligationId: 'fixture-obligation', evidence: {} },
  };
  spyOn(lanes, 'getSchedulerLane').mockResolvedValue(target.lane as never);
  spyOn(lanes, 'startSchedulerLane').mockResolvedValue(target as never);
  spyOn(lanes, 'fenceSchedulerLaneTarget').mockResolvedValue(target as never);
  spyOn(lanes, 'completeSchedulerLane').mockResolvedValue({ ok: true } as never);
  const { createDataSyncWorker } = await import('../../src/workers/data-sync.worker');
  const { createFplCriticalSyncWorker } = await import(
    '../../src/workers/fpl-critical-sync.worker'
  );
  createDataSyncWorker();
  createFplCriticalSyncWorker();
});
afterEach(async () => {
  mock.restore();
  if (previousFlag === undefined) delete process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED;
  else process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED = previousFlag;
  await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${marker}`;
});
afterAll(() => observer.end());
function run(queue: string) {
  return processors.get(queue)!({
    id: 'fixture-job',
    name: 'price-change-predictions',
    queueName: queue,
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: Date.now(),
    data: { ...TEST_SEASON, laneId: 'fixture-lane', laneGeneration: 1, source: 'manual' },
  });
}
for (const queue of ['data-sync', 'fpl-critical-sync']) {
  test(`${queue} reconciles only after the publication transaction commits`, async () => {
    await run(queue);
    expect(seen).toEqual([{ transaction: false, committed: true }]);
  });
  test(`${queue} propagates handoff failure while preserving committed work for retry`, async () => {
    failEnqueue = true;
    await expect(run(queue)).rejects.toThrow('queue handoff unavailable');
    expect(seen).toEqual([{ transaction: false, committed: true }]);
    failEnqueue = false;
    await run(queue);
    expect(seen).toHaveLength(2);
    expect(syncOperationsRepository.failRun).not.toHaveBeenCalled();
  });
}
