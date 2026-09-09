import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { databaseTransactionStorage, getDbClient } from '../../src/db/singleton';
import { prepareCoreSnapshot } from '../../src/domain/core-snapshot';
import * as persistence from '../../src/services/core-snapshot-persistence.service';
import { persistCoreSnapshotPublication } from '../../src/services/core-snapshot-publication.service';
import * as reporting from '../../src/services/player-season-summaries.service';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';

const fixture = buildCoreSnapshotFixture();
const snapshot = prepareCoreSnapshot(fixture.bootstrap, fixture.fixtures);
const context = {
  publicationId: randomUUID(),
  sourceRunId: randomUUID(),
  revision: 1,
  sourceCheckedAt: new Date(),
};
const counts = { events: 38, teams: 20, players: 220, phases: 10, fixtures: 380 };
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
const scopes: string[] = [];
const persistenceSpy = spyOn(persistence, 'persistCoreSnapshot');
const reportingSpy = spyOn(reporting, 'refreshPlayerSeasonSummaries');

function scopeInput() {
  const scope = `core-reporting-test:${randomUUID()}`;
  scopes.push(scope);
  return { queueName: 'data-sync', jobName: 'core-snapshot', scopes: [scope] };
}

afterEach(async () => {
  persistenceSpy.mockReset();
  reportingSpy.mockReset();
  for (const scope of scopes.splice(0)) {
    await observer`DELETE FROM ops.mutation_scopes WHERE scope_key = ${scope}`;
  }
});

afterAll(async () => {
  persistenceSpy.mockRestore();
  reportingSpy.mockRestore();
  await observer.end();
});

test('core reporting sees committed scope rows and can acquire the released outer lock', async () => {
  const input = scopeInput();
  persistenceSpy.mockResolvedValue({ snapshot, persistence: counts });
  let transactionPresent = true;
  let committedRows = 0;
  reportingSpy.mockImplementation(async () => {
    transactionPresent = Boolean(databaseTransactionStorage.getStore());
    const rows = await observer.begin(async (tx) => {
      return tx`SELECT scope_key FROM ops.mutation_scopes
        WHERE scope_key = ${input.scopes[0]} FOR UPDATE NOWAIT`;
    });
    committedRows = rows.length;
    throw new Error('projection failure must not invalidate committed core facts');
  });
  await withMutationScopes(input, async () => {
    await withMutationScopes(input, () => persistCoreSnapshotPublication(snapshot, context));
    expect(reportingSpy).not.toHaveBeenCalled();
  });
  expect(reportingSpy).toHaveBeenCalledTimes(1);
  expect(transactionPresent).toBe(false);
  expect(committedRows).toBe(1);
});

test('outer rollback discards the deferred core reporting refresh', async () => {
  const input = scopeInput();
  persistenceSpy.mockResolvedValue({ snapshot, persistence: counts });
  await expect(
    withMutationScopes(input, async () => {
      await persistCoreSnapshotPublication(snapshot, context);
      throw new Error('rollback canonical publication');
    }),
  ).rejects.toThrow('rollback canonical publication');
  expect(reportingSpy).not.toHaveBeenCalled();
  const rows = await observer`SELECT scope_key FROM ops.mutation_scopes
    WHERE scope_key = ${input.scopes[0]}`;
  expect(rows).toHaveLength(0);
});

test('SQL failure in reporting cannot abort the core transaction', async () => {
  const input = scopeInput();
  persistenceSpy.mockResolvedValue({ snapshot, persistence: counts });
  reportingSpy.mockImplementation(async () => {
    const client = await getDbClient();
    await client`SELECT 1 / 0`;
    throw new Error('unreachable');
  });
  await withMutationScopes(input, async () => {
    await persistCoreSnapshotPublication(snapshot, context);
    const client = await getDbClient();
    await client`SELECT 1`;
  });
  expect(reportingSpy).toHaveBeenCalledTimes(1);
  const rows = await observer`SELECT scope_key FROM ops.mutation_scopes
    WHERE scope_key = ${input.scopes[0]}`;
  expect(rows).toHaveLength(1);
});
