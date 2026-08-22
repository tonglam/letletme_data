import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalHttpWorker } from '../../src/content/workers/formal-http.worker';
import {
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

const liveTest = process.env.RUN_BRIEFING_LIVE_PROBES === '1' ? test : test.skip;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

liveTest(
  'runs every public feed through the formal worker, ReceiptRevision, and outbox',
  async () => {
    const bundle = await loadBriefingManifest();
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'live-feed-pipeline-test' });
    const db = await getDb();
    const adapterKinds = ['RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL'] as const;
    await db
      .update(contentSourceSchedules)
      .set({
        nextDueAt: new Date(Date.now() - 60_000),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(inArray(contentSourceSchedules.adapterKind, adapterKinds));

    const claimed = await claimDueFormalRuns({
      enabledAdapters: adapterKinds,
      claimLimit: 100,
    });
    expect(claimed).toHaveLength(21);
    const flags = {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      httpAcquisitionEnabled: true,
      youtubeDiscoveryEnabled: true,
    };
    const results: Awaited<ReturnType<typeof runFormalHttpWorker>>[] = [];
    for (let offset = 0; offset < claimed.length; offset += 4) {
      const chunk = claimed.slice(offset, offset + 4);
      const chunkResults = await Promise.all(
        chunk.map(async (run) => {
          expect(await confirmFormalRunEnqueued({ runId: run.runId })).toBe(true);
          return runFormalHttpWorker(run.job, { flags, db });
        }),
      );
      results.push(...chunkResults);
    }

    const expectedReceipts = results.reduce((total, result) => total + result.receiptCount, 0);
    const expectedRevisions = results.reduce((total, result) => total + result.revisionCount, 0);
    const expectedOutbox = results.reduce((total, result) => total + result.outboxCount, 0);
    const [counts] = await db
      .select({
        receipts: sql<number>`count(DISTINCT ${contentSourceReceipts.receiptId})::int`,
        revisions: sql<number>`count(DISTINCT ${contentSourceReceiptRevisions.receiptRevisionId})::int`,
        outbox: sql<number>`count(DISTINCT ${contentPipelineOutbox.outboxId})::int`,
      })
      .from(contentSourceReceipts)
      .leftJoin(
        contentSourceReceiptRevisions,
        eq(contentSourceReceiptRevisions.receiptId, contentSourceReceipts.receiptId),
      )
      .leftJoin(
        contentPipelineOutbox,
        eq(contentPipelineOutbox.receiptId, contentSourceReceipts.receiptId),
      );
    const identityRows = await db
      .select({ status: contentSourceEndpoints.identityStatus })
      .from(contentSourceEndpoints)
      .where(inArray(contentSourceEndpoints.adapterKind, adapterKinds));

    expect(expectedReceipts).toBeGreaterThan(0);
    expect(counts).toEqual({
      receipts: expectedReceipts,
      revisions: expectedRevisions,
      outbox: expectedOutbox,
    });
    expect(identityRows).toHaveLength(21);
    expect(identityRows.every((row) => row.status === 'VERIFIED')).toBe(true);
    const stateCounts = results.reduce<Record<string, number>>((countsByState, result) => {
      countsByState[result.status] = (countsByState[result.status] ?? 0) + 1;
      return countsByState;
    }, {});
    console.warn(
      `[briefing-feed-pipeline-live] ${JSON.stringify({
        counts,
        stateCounts,
        triggeredJobs: results.reduce((total, result) => total + result.triggeredJobCount, 0),
      })}`,
    );
  },
  180_000,
);
