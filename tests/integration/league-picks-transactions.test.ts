import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { databaseTransactionStorage } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { tournamentEntryRepository } from '../../src/repositories/tournament-entries';
import * as entries from '../../src/services/entries.service';
import { processLeagueEventPicksJob } from '../../src/services/league-sync.service';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
const eventId = 995;
const tournamentId = 995_601;
const scope = `entry-event-picks:event:${eventId}`;
const completed = new Set<number>();

async function acquireFromAnotherConnection() {
  return observer.begin(async (tx) => {
    await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
  });
}

beforeEach(async () => {
  completed.clear();
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES (${scope},now())
    ON CONFLICT(scope_key) DO NOTHING`;
  spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([{ id: tournamentId }] as never);
  spyOn(tournamentInfoRepository, 'findById').mockResolvedValue({
    id: tournamentId,
    totalTeamNum: 2,
  } as never);
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([101, 102]);
  spyOn(entryInfoRepository, 'findByIds').mockResolvedValue([
    { id: 101, startedEvent: 1 },
    { id: 102, startedEvent: 1 },
  ] as never);
  spyOn(entryEventPicksRepository, 'findEntryIdsByEvent').mockImplementation(
    async (_season, _eventId, ids) => (ids ?? []).filter((id) => completed.has(id)),
  );
});
afterEach(async () => {
  mock.restore();
  await observer`DELETE FROM ops.mutation_scopes WHERE scope_key IN (${scope},${`league-event-picks:tournament:${tournamentId}`})`;
});
afterAll(() => observer.end());

test('coordinator provider work is outside a transaction while checkpoint writes remain locked', async () => {
  const providerContexts: boolean[] = [];
  const sync = spyOn(entries, 'syncEntryEventPicks').mockImplementation(
    async (_season, entryId) => {
      providerContexts.push(databaseTransactionStorage.getStore() !== undefined);
      // Stand in for a delayed provider response: another database connection
      // must remain able to acquire the shared event scope during that wait.
      await acquireFromAnotherConnection();
      await withMutationScopes(
        { queueName: 'entry-sync', jobName: 'entry-picks', scopes: [scope] },
        async () => {
          expect(databaseTransactionStorage.getStore()).toBeDefined();
          await expect(acquireFromAnotherConnection()).rejects.toMatchObject({ code: '55P03' });
        },
      );
      completed.add(entryId);
      return { entryId, eventId };
    },
  );
  await expect(processLeagueEventPicksJob(TEST_SEASON, eventId)).resolves.toMatchObject({
    succeededUnits: 2,
    failedUnits: 0,
  });
  expect(providerContexts).toEqual([false, false]);
  expect(sync).toHaveBeenCalledTimes(2);
  await acquireFromAnotherConnection();
});

test('a failed entry keeps the attempt incomplete and retry reuses completed checkpoints', async () => {
  let fail = true;
  const attempts: number[] = [];
  spyOn(entries, 'syncEntryEventPicks').mockImplementation(async (_season, entryId) => {
    expect(databaseTransactionStorage.getStore()).toBeUndefined();
    attempts.push(entryId);
    if (entryId === 102 && fail) throw new Error('provider unavailable');
    completed.add(entryId);
    return { entryId, eventId };
  });
  await expect(processLeagueEventPicksJob(TEST_SEASON, eventId)).rejects.toMatchObject({
    failedUnits: 1,
    succeededUnits: 1,
  });
  fail = false;
  await expect(processLeagueEventPicksJob(TEST_SEASON, eventId)).resolves.toMatchObject({
    reusedUnits: 1,
    succeededUnits: 1,
    failedUnits: 0,
  });
  expect(attempts.filter((id) => id === 101)).toHaveLength(1);
  expect(attempts.filter((id) => id === 102)).toHaveLength(2);
});

test('the worker also leaves a single-tournament provider call outside its transaction', async () => {
  const bullmq = await import('bullmq');
  const seasons = await import('../../src/services/season-scoped-job.service');
  const fences = await import('../../src/utils/scheduler-obligation-fence');
  const attempts = await import('../../src/utils/data-sync-attempt');
  const tracking = await import('../../src/utils/job-run-logger');
  const connections = await import('../../src/utils/queue');
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
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(TEST_SEASON);
  spyOn(fences, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(attempts, 'runDataSyncAttempt').mockImplementation(async (_input, operation) =>
    operation(),
  );
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  const contexts: boolean[] = [];
  spyOn(entries, 'syncEntryEventPicks').mockImplementation(async (_season, entryId) => {
    contexts.push(databaseTransactionStorage.getStore() !== undefined);
    await acquireFromAnotherConnection();
    completed.add(entryId);
    return { entryId, eventId };
  });
  const { createLeagueSyncWorker } = await import('../../src/workers/league-sync.worker');
  createLeagueSyncWorker();
  expect(processor).toBeDefined();
  await expect(
    processor!({
      id: 'fixture',
      name: 'league-event-picks',
      queueName: 'league-sync',
      attemptsMade: 0,
      timestamp: Date.now(),
      data: {
        ...TEST_SEASON,
        eventId,
        tournamentId,
        source: 'manual',
        triggeredAt: new Date().toISOString(),
        obligationId: '00000000-0000-4000-8000-000000000001',
        obligationGeneration: 1,
      },
    }),
  ).resolves.toMatchObject({ succeededUnits: 2, failedUnits: 0 });
  expect(contexts).toEqual([false, false]);
});
