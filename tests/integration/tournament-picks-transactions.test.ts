import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { databaseTransactionStorage } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { tournamentEntryRepository } from '../../src/repositories/tournament-entries';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import * as entries from '../../src/services/entries.service';
import * as trends from '../../src/services/tournament-trends-publication.service';
import * as seasons from '../../src/services/season-scoped-job.service';
import * as fences from '../../src/utils/scheduler-obligation-fence';
import * as attempts from '../../src/utils/data-sync-attempt';
import * as tracking from '../../src/utils/job-run-logger';
import { processTournamentSyncJob } from '../../src/workers/tournament-sync.worker';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
const eventId = 37;
const scope = `entry-event-picks:event:${eventId}`;
const completed = new Set<number>();
const providerContexts: boolean[] = [];
const publicationContexts: boolean[] = [];
const fetched: number[] = [];
const ready = { succeeded: 1, failed: 0, results: [{ isActive: true }] } as never;
async function run() {
  return processTournamentSyncJob({
    id: 'tournament-picks-fixture',
    name: 'tournament-event-picks',
    queueName: 'tournament-sync',
    attemptsMade: 0,
    data: { ...TEST_SEASON, eventId, source: 'manual' },
  } as never);
}
beforeEach(async () => {
  completed.clear();
  providerContexts.length = 0;
  publicationContexts.length = 0;
  fetched.length = 0;
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
  spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([{ id: 995_801 }] as never);
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([101, 102]);
  spyOn(entryInfoRepository, 'findByIds').mockResolvedValue([
    { id: 101, startedEvent: 1 },
    { id: 102, startedEvent: 1 },
  ] as never);
  spyOn(entryEventPicksRepository, 'findEntryIdsByEvent').mockImplementation(
    async (_season, _event, ids) => (ids ?? []).filter((id) => completed.has(id)),
  );
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(TEST_SEASON);
  spyOn(fences, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(attempts, 'runDataSyncAttempt').mockImplementation(async (_input, operation) =>
    operation(),
  );
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  spyOn(entries, 'syncEntryEventPicks').mockImplementation(async (_season, entryId) => {
    const inTransaction = Boolean(databaseTransactionStorage.getStore());
    providerContexts.push(inTransaction);
    fetched.push(entryId);
    if (!inTransaction)
      await observer.begin(async (tx) => {
        await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
      });
    completed.add(entryId);
    return { entryId, eventId };
  });
  spyOn(trends, 'publishTournamentTrendScopes').mockImplementation(async () => {
    publicationContexts.push(Boolean(databaseTransactionStorage.getStore()));
    return ready;
  });
});
afterEach(() => mock.restore());
afterAll(() => observer.end());

test('worker releases the batch transaction for providers and for the publisher own snapshot', async () => {
  expect(await run()).toMatchObject({ succeededUnits: 2, failedUnits: 0 });
  expect(providerContexts).toEqual([false, false]);
  expect(publicationContexts).toEqual([false]);
});

test('a failed required publication rejects the job and retry reuses durable picks', async () => {
  spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue({
    succeeded: 0,
    failed: 1,
    results: [],
  });
  await expect(run()).rejects.toMatchObject({ failedUnits: 1 });
  spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue(ready);
  expect(await run()).toMatchObject({ reusedUnits: 2, succeededUnits: 0, failedUnits: 0 });
  expect(fetched).toEqual([101, 102]);
});

test('an inactive publication is incomplete even when its SQL call returned successfully', async () => {
  spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue({
    succeeded: 1,
    failed: 0,
    results: [{ isActive: false }],
  } as never);
  await expect(run()).rejects.toMatchObject({ failedUnits: 1, succeededUnits: 0 });
});

test('an unfinished entry prevents publication and retry fetches only the remaining unit', async () => {
  let fail = true;
  spyOn(entries, 'syncEntryEventPicks').mockImplementation(async (_season, entryId) => {
    if (entryId === 102 && fail) throw new Error('provider unavailable');
    completed.add(entryId);
    fetched.push(entryId);
    return { entryId, eventId };
  });
  await expect(run()).rejects.toMatchObject({ failedUnits: 1 });
  expect(trends.publishTournamentTrendScopes).not.toHaveBeenCalled();
  fail = false;
  expect(await run()).toMatchObject({ reusedUnits: 1, succeededUnits: 1, failedUnits: 0 });
  expect(fetched).toEqual([101, 102]);
});
