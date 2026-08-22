import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { dispatchAcquisitionJobOutbox } from '../../src/content/acquisition/job-outbox';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalHttpWorker } from '../../src/content/workers/formal-http.worker';
import {
  contentAcquisitionHttpTraces,
  contentAcquisitionJobOutbox,
  contentAcquisitionRuns,
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test('executes a claimed feed run from only its run ID and commits the formal result atomically', async () => {
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'formal-http-worker-test' });
  const db = await getDb();
  const endpointKey = 'fantasy-football-scout-rss';
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, endpointKey))
    .limit(1);
  if (!endpoint) throw new Error('Fixture endpoint is missing');
  await db
    .update(contentSourceSchedules)
    .set({ status: 'paused' })
    .where(ne(contentSourceSchedules.endpointId, endpoint.endpointId));
  await db
    .update(contentSourceSchedules)
    .set({
      status: 'active',
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(contentSourceSchedules.endpointId, endpoint.endpointId));

  const claimed = await claimDueFormalRuns({ enabledAdapters: ['RSS_ATOM'], claimLimit: 1 });
  expect(claimed).toHaveLength(1);
  const run = claimed[0]!;
  expect(Object.keys(run.job).sort()).toEqual(['runId', 'schemaVersion']);
  expect(await confirmFormalRunEnqueued({ runId: run.runId })).toBe(true);

  const publishedAt = new Date(Date.now() - 5 * 60_000).toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Scout</title><link>https://www.fantasyfootballscout.co.uk/</link>
      <item><guid>formal-worker-guid-1</guid><title>Formal worker item</title>
        <link>https://www.fantasyfootballscout.co.uk/formal-worker-item</link>
        <pubDate>${publishedAt}</pubDate><description><![CDATA[<p>Useful excerpt.</p>]]></description>
      </item>
    </channel></rss>`;
  const fetchImpl = async () =>
    new Response(xml, {
      status: 200,
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        etag: '"formal-worker-v1"',
      },
    });
  const flags = {
    ...getContentRuntimeFlags(),
    pipelineEnabled: true,
    acquisitionShadowMode: true,
    httpAcquisitionEnabled: true,
  };
  const result = await runFormalHttpWorker(run.job, { flags, fetchImpl });
  expect(result).toMatchObject({
    runId: run.runId,
    status: 'COMPLETED',
    receiptCount: 1,
    revisionCount: 1,
    outboxCount: 1,
    triggeredJobCount: 1,
  });

  const [terminal] = await db
    .select({ status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, run.runId));
  const traces = await db
    .select({ operation: contentAcquisitionHttpTraces.operation })
    .from(contentAcquisitionHttpTraces)
    .where(eq(contentAcquisitionHttpTraces.runId, run.runId));
  const receipts = await db
    .select({ receiptId: contentSourceReceipts.receiptId })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.externalId, 'formal-worker-guid-1'));
  const outbox = await db
    .select({ eventType: contentPipelineOutbox.eventType })
    .from(contentPipelineOutbox)
    .where(
      inArray(
        contentPipelineOutbox.receiptId,
        receipts.map((receipt) => receipt.receiptId),
      ),
    );
  expect(terminal?.status).toBe('COMPLETED');
  expect(traces).toEqual([{ operation: 'feed.fetch' }]);
  expect(receipts).toHaveLength(1);
  expect(outbox).toEqual([{ eventType: 'receipt.accepted.v1' }]);

  const childRuns = await db
    .select({ runId: contentAcquisitionRuns.runId, status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, run.runId));
  expect(childRuns).toHaveLength(1);
  expect(childRuns[0]?.status).toBe('PENDING');
  const pendingJobs = await db
    .select({ deliveredAt: contentAcquisitionJobOutbox.deliveredAt })
    .from(contentAcquisitionJobOutbox)
    .where(eq(contentAcquisitionJobOutbox.runId, childRuns[0]!.runId));
  expect(pendingJobs).toEqual([{ deliveredAt: null }]);
  const enqueued: string[] = [];
  const dispatch = await dispatchAcquisitionJobOutbox({
    enqueue: async (job) => {
      expect(Object.keys(job.job).sort()).toEqual(['runId', 'schemaVersion']);
      enqueued.push(job.runId);
    },
  });
  expect(dispatch).toEqual({ claimed: 1, delivered: 1, failed: 0 });
  expect(enqueued).toEqual([childRuns[0]!.runId]);
});
