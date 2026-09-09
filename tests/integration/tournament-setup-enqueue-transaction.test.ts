import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { databaseTransactionStorage } from '../../src/db/singleton';
import { tournamentSetupEnqueueScope } from '../../src/domain/mutation-scope';
import { tournamentSetupQueue } from '../../src/queues/tournament-setup.queue';
import * as governance from '../../src/services/queue-governance.service';
import { enqueueTournamentSetup } from '../../src/jobs/tournament-setup.jobs';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
afterAll(() => observer.end());

test('setup enqueue releases its database scope before waiting for Redis', async () => {
  const tournamentId = 995990;
  const scope = tournamentSetupEnqueueScope(tournamentId);
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  let transactionDuringQueue = false;
  spyOn(governance, 'isQueueDrainOnly').mockResolvedValue(false);
  spyOn(tournamentSetupQueue, 'getJob').mockImplementation(async () => {
    if (first) {
      first = false;
      transactionDuringQueue = Boolean(databaseTransactionStorage.getStore());
      reached();
      await barrier;
    }
    return undefined;
  });
  spyOn(tournamentSetupQueue, 'add').mockResolvedValue({ id: 'fixture' } as never);
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
  const pending = enqueueTournamentSetup(TEST_SEASON, tournamentId, 'create');
  let blocker: string | null = null;
  try {
    await entered;
    try {
      await observer.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE`;
      });
    } catch (error) {
      blocker = (error as { code?: string }).code ?? 'unknown';
    }
  } finally {
    release();
    await pending;
    mock.restore();
    await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${scope}`;
  }
  expect({ transactionDuringQueue, blocker }).toEqual({
    transactionDuringQueue: false,
    blocker: null,
  });
});

test('prepared setup enqueue commits its marker before waiting for Redis', async () => {
  const tournamentId = 995991;
  const scope = tournamentSetupEnqueueScope(tournamentId);
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transactionDuringQueue = true;
  let preparedInTransaction = false;
  spyOn(governance, 'isQueueDrainOnly').mockResolvedValue(false);
  spyOn(tournamentSetupQueue, 'getJob').mockResolvedValue(undefined);
  spyOn(tournamentSetupQueue, 'add').mockImplementation(async () => {
    transactionDuringQueue = Boolean(databaseTransactionStorage.getStore());
    reached();
    await barrier;
    return { id: 'prepared-fixture' } as never;
  });
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
  const pending = enqueueTournamentSetup(TEST_SEASON, tournamentId, 'manual', {
    prepareEnqueue: async () => {
      preparedInTransaction = Boolean(databaseTransactionStorage.getStore());
    },
  });
  let blocker: string | null = null;
  try {
    await entered;
    try {
      await observer.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE`;
      });
    } catch (error) {
      blocker = (error as { code?: string }).code ?? 'unknown';
    }
  } finally {
    release();
    await pending;
    mock.restore();
    await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${scope}`;
  }
  expect({ preparedInTransaction, transactionDuringQueue, blocker }).toEqual({
    preparedInTransaction: true,
    transactionDuringQueue: false,
    blocker: null,
  });
});
