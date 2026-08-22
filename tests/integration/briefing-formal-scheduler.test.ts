import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  beginFormalRun,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
  failFormalRun,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import {
  contentAcquisitionRuns,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test('concurrent formal schedulers claim each due feed exactly once with runId-only jobs', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const expectedFeedCount =
    bundle.coverage.endpointCounts.RSS_ATOM +
    bundle.coverage.endpointCounts.PODCAST_FEED +
    bundle.coverage.endpointCounts.YOUTUBE_CHANNEL;
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'formal-scheduler-test' });
  const db = await getDb();
  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      inArray(contentSourceSchedules.adapterKind, ['RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL']),
    );

  const enabledAdapters = ['RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL'] as const;
  const [left, right] = await Promise.all([
    claimDueFormalRuns({ enabledAdapters, claimLimit: 100 }),
    claimDueFormalRuns({ enabledAdapters, claimLimit: 100 }),
  ]);
  const claimed = [...left, ...right];
  expect(claimed).toHaveLength(expectedFeedCount);
  expect(new Set(claimed.map((run) => run.scheduleId)).size).toBe(expectedFeedCount);
  expect(
    claimed.every((run) => Object.keys(run.job).sort().join(',') === 'runId,schemaVersion'),
  ).toBe(true);
  expect(claimed.every((run) => run.queueKind === 'HTTP' && run.jobKind === 'FEED_POLL')).toBe(
    true,
  );

  const persisted = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      status: contentAcquisitionRuns.status,
      requestSnapshot: contentAcquisitionRuns.requestSnapshot,
    })
    .from(contentAcquisitionRuns)
    .where(
      inArray(
        contentAcquisitionRuns.runId,
        claimed.map((run) => run.runId),
      ),
    );
  expect(persisted).toHaveLength(expectedFeedCount);
  expect(persisted.every((run) => run.status === 'PENDING')).toBe(true);
  expect(
    persisted.every((run) => (run.requestSnapshot as { jobKind?: string }).jobKind === 'FEED_POLL'),
  ).toBe(true);

  const first = claimed[0]!;
  expect(await confirmFormalRunEnqueued({ runId: first.runId })).toBe(true);
  const begun = await beginFormalRun({ runId: first.runId });
  expect(begun.status).toBe('RUNNING');
  expect(begun.request.jobKind).toBe('FEED_POLL');
  const duplicate = await beginFormalRun({ runId: first.runId });
  expect(duplicate.status).toBe('TERMINAL');

  expect(
    await failFormalRun({
      runId: first.runId,
      failureClass: 'CONTROLLED_RETRY_TEST',
      errorSummary: 'controlled retry test',
    }),
  ).toBe(true);
  await db
    .update(contentSourceSchedules)
    .set({ nextDueAt: new Date(Date.now() - 1_000) })
    .where(eq(contentSourceSchedules.scheduleId, first.scheduleId!));
  const [retry] = await claimDueFormalRuns({
    enabledAdapters,
    claimLimit: 1,
  });
  if (!retry) throw new Error('Failed recurring feed was not retried');
  expect(retry.scheduleId).toBe(first.scheduleId);
  expect(retry.requestHash).toBe(first.requestHash);
  const [retryRow] = await db
    .select({
      attemptNo: contentAcquisitionRuns.attemptNo,
      requestSnapshot: contentAcquisitionRuns.requestSnapshot,
      sourceSnapshot: contentAcquisitionRuns.sourceSnapshot,
      endpointSnapshot: contentAcquisitionRuns.endpointSnapshot,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, retry.runId));
  const [firstRow] = await db
    .select({
      requestSnapshot: contentAcquisitionRuns.requestSnapshot,
      sourceSnapshot: contentAcquisitionRuns.sourceSnapshot,
      endpointSnapshot: contentAcquisitionRuns.endpointSnapshot,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, first.runId));
  expect(retryRow?.attemptNo).toBe(2);
  expect(retryRow?.requestSnapshot).toEqual(firstRow?.requestSnapshot);
  expect(retryRow?.sourceSnapshot).toEqual(firstRow?.sourceSnapshot);
  expect(retryRow?.endpointSnapshot).toEqual(firstRow?.endpointSnapshot);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentSourceSchedules)
    .where(eq(contentSourceSchedules.jobKind, 'FEED_POLL'));
  expect(count).toBe(expectedFeedCount);
});
