import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';

import {
  articleHttpTraces,
  runArticleAdapter,
} from '../../src/content/acquisition/article-adapter';
import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import { getAcquisitionProfile } from '../../src/content/acquisition/acquisition-profiles';
import { sha256CanonicalJson } from '../../src/content/acquisition/canonicalization';
import { feedHttpTrace, runFeedAdapter } from '../../src/content/acquisition/feed-adapter';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import {
  acquisitionReceiptKey,
  persistAcquisitionResult,
} from '../../src/content/acquisition/receipt-repository';
import {
  contentAcquisitionHttpTraces,
  contentAcquisitionRuns,
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
  'upgrades one live feed discovery into an immutable full article revision',
  async () => {
    const bundle = await loadBriefingManifest();
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'live-article-pipeline-test' });
    const db = await getDb();
    const entity = bundle.sources.entities.find((entry) => entry.sourceKey === 'all-about-fpl');
    const endpoint = entity?.endpoints.find((entry) => entry.endpointKey === 'all-about-fpl-rss');
    if (!entity || !endpoint) throw new Error('AllAboutFPL feed endpoint is not configured');
    const profile = getAcquisitionProfile(endpoint.profileKey);
    if (!profile) throw new Error(`Missing profile ${endpoint.profileKey}`);

    const [runtime] = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        scheduleId: contentSourceSchedules.scheduleId,
      })
      .from(contentSourceEndpoints)
      .innerJoin(
        contentSourceSchedules,
        eq(contentSourceSchedules.endpointId, contentSourceEndpoints.endpointId),
      )
      .where(eq(contentSourceEndpoints.endpointKey, endpoint.endpointKey))
      .limit(1);
    if (!runtime) throw new Error('AllAboutFPL runtime endpoint is missing');

    const cutoffAt = new Date();
    const feed = await runFeedAdapter({
      endpointKey: endpoint.endpointKey,
      adapterKind: 'RSS_ATOM',
      profileKey: endpoint.profileKey,
      locator: endpoint.locator as Record<string, string>,
      bootstrapProfile: profile,
      bootstrapCutoffAt: cutoffAt,
    });
    const discoveryItem = feed.batch.items.find(
      (item) => item.contentKind === 'ARTICLE' && item.linkAvailability === 'DIRECT',
    );
    if (!discoveryItem) throw new Error('Live feed returned no directly fetchable article');

    const feedRunId = randomUUID();
    const feedLeaseExpiresAt = new Date(Date.now() + 6 * 60_000);
    const feedRequestSnapshot = {
      schemaVersion: 1,
      endpointKey: endpoint.endpointKey,
      adapterKind: endpoint.adapterKind,
      profileKey: endpoint.profileKey,
      profileRevision: profile.revision,
      locator: endpoint.locator,
      bootstrapCutoffAt: cutoffAt.toISOString(),
      bootstrap: profile.bootstrap,
    };
    await db
      .update(contentSourceSchedules)
      .set({ leaseOwner: feedRunId, leaseExpiresAt: feedLeaseExpiresAt })
      .where(eq(contentSourceSchedules.scheduleId, runtime.scheduleId));
    await db.insert(contentAcquisitionRuns).values({
      runId: feedRunId,
      endpointId: runtime.endpointId,
      scheduleId: runtime.scheduleId,
      jobKind: 'FEED_POLL',
      adapterKind: 'RSS_ATOM',
      profileKey: endpoint.profileKey,
      profileRevision: profile.revision,
      windowStart: new Date(cutoffAt.getTime() - profile.bootstrap.lookbackMinutes * 60_000),
      windowEnd: cutoffAt,
      idempotencyKey: `briefing-live-article-feed:${feedRunId}`,
      status: 'RUNNING',
      requestSnapshot: feedRequestSnapshot,
      requestHash: sha256CanonicalJson(feedRequestSnapshot),
      sourceSnapshot: [{ sourceKey: entity.sourceKey }],
      endpointSnapshot: { endpointKey: endpoint.endpointKey },
      attemptNo: 1,
      evidenceMode: 'HTTP_DETERMINISTIC',
      startedAt: new Date(),
      leaseExpiresAt: feedLeaseExpiresAt,
    });
    const discoveryBatch = { ...feed.batch, items: [discoveryItem] };
    const discoveryPersisted = await persistAcquisitionResult({
      runId: feedRunId,
      state: 'COMPLETED',
      batches: [discoveryBatch],
      checkpointComplete: true,
      checkpoint: {
        checkedAt: feed.batch.checkedAt,
        newestExternalItemId: discoveryItem.externalItemId,
      },
      nextDueAt: new Date(Date.now() + profile.cadenceMinutes.NORMAL * 60_000),
      endpointIdentityEvidence: {
        [endpoint.endpointKey]: { stableExternalId: feed.transport.finalUrl },
      },
      httpTraces: [{ operation: 'feed.fetch', sequence: 0, ...feedHttpTrace(feed.transport) }],
    });
    expect(discoveryPersisted.revisionCount).toBe(1);

    const article = await runArticleAdapter({
      endpointKey: endpoint.endpointKey,
      discoveryItem,
      allowedOrigins: [new URL(feed.transport.finalUrl).origin],
    });
    const articleRunId = randomUUID();
    const articleRequestSnapshot = {
      schemaVersion: 1,
      endpointKey: endpoint.endpointKey,
      externalItemId: discoveryItem.externalItemId,
      sourceUrl: discoveryItem.sourceUrl,
      allowedOrigins: [new URL(feed.transport.finalUrl).origin],
      validator: null,
    };
    const articleWindow = new Date();
    await db.insert(contentAcquisitionRuns).values({
      runId: articleRunId,
      endpointId: runtime.endpointId,
      parentRunId: feedRunId,
      jobKind: 'ARTICLE_FETCH',
      adapterKind: 'ARTICLE_HTTP',
      profileKey: 'article-readability-v1',
      profileRevision: 1,
      windowStart: articleWindow,
      windowEnd: articleWindow,
      idempotencyKey: `briefing-live-article-fetch:${articleRunId}`,
      status: 'RUNNING',
      requestSnapshot: articleRequestSnapshot,
      requestHash: sha256CanonicalJson(articleRequestSnapshot),
      sourceSnapshot: [{ sourceKey: entity.sourceKey }],
      endpointSnapshot: { endpointKey: endpoint.endpointKey },
      attemptNo: 1,
      evidenceMode: 'HTTP_DETERMINISTIC',
      startedAt: articleWindow,
      leaseExpiresAt: new Date(articleWindow.getTime() + 6 * 60_000),
    });
    const articlePersisted = await persistAcquisitionResult({
      runId: articleRunId,
      state: article.stateHint,
      batches: [article.batch],
      checkpointComplete: false,
      httpTraces: articleHttpTraces(article),
      runMetrics: { extraction: article.extraction },
    });

    const receiptKey = acquisitionReceiptKey({
      sourceKey: entity.sourceKey,
      contentKind: discoveryItem.contentKind,
      externalItemId: discoveryItem.externalItemId,
    });
    const [receipt] = await db
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(eq(contentSourceReceipts.receiptKey, receiptKey))
      .limit(1);
    if (!receipt) throw new Error('Article Receipt was not persisted');
    const revisions = await db
      .select({
        revisionNumber: contentSourceReceiptRevisions.revisionNumber,
        bodyAvailability: contentSourceReceiptRevisions.bodyAvailability,
      })
      .from(contentSourceReceiptRevisions)
      .where(eq(contentSourceReceiptRevisions.receiptId, receipt.receiptId))
      .orderBy(asc(contentSourceReceiptRevisions.revisionNumber));
    const articleTraces = await db
      .select({ operation: contentAcquisitionHttpTraces.operation })
      .from(contentAcquisitionHttpTraces)
      .where(eq(contentAcquisitionHttpTraces.runId, articleRunId))
      .orderBy(asc(contentAcquisitionHttpTraces.sequence));
    const outbox = await db
      .select({ eventType: contentPipelineOutbox.eventType })
      .from(contentPipelineOutbox)
      .where(eq(contentPipelineOutbox.receiptId, receipt.receiptId))
      .orderBy(asc(contentPipelineOutbox.occurredAt));

    expect(articlePersisted).toMatchObject({ revisionCount: 1, outboxCount: 1 });
    expect(revisions).toEqual([
      { revisionNumber: 1, bodyAvailability: 'EXCERPT' },
      { revisionNumber: 2, bodyAvailability: 'FULL' },
    ]);
    expect(articleTraces).toEqual([{ operation: 'robots.fetch' }, { operation: 'article.fetch' }]);
    expect(outbox.map((event) => event.eventType)).toEqual([
      'receipt.accepted.v1',
      'receipt.updated.v1',
    ]);
    console.warn(
      `[briefing-article-pipeline-live] ${JSON.stringify({
        externalItemId: discoveryItem.externalItemId,
        sourceUrl: discoveryItem.sourceUrl,
        revisions,
        articleTraces,
        extraction: article.extraction,
        articlePersisted,
      })}`,
    );
  },
  120_000,
);
