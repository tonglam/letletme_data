import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';
import { eq, ne, sql } from 'drizzle-orm';

import type { AcquisitionBatchV1 } from '../../src/content/acquisition/acquisition-contract';
import {
  loadBriefingManifest,
  parseBriefingManifest,
} from '../../src/content/acquisition/acquisition-manifest';
import {
  beginFormalRun,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { persistAcquisitionResult } from '../../src/content/acquisition/receipt-repository';
import {
  contentPipelineOutbox,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourceObservations,
  contentSourcePartitionMembers,
  contentSourcePartitions,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceRegistryReconciliations,
  contentSourceSchedules,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

describe('Briefing source registry reconciliation', () => {
  test('atomically applies the manifest and makes the same hash an unchanged no-op', async () => {
    await resetBriefingAcquisitionState();
    const bundle = await loadBriefingManifest();
    const first = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: 'integration-test',
    });
    const second = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: 'integration-test',
    });

    expect(first).toMatchObject({
      status: 'APPLIED',
      entityCount: 85,
      endpointCount: 108,
      partitionCount: 44,
      scheduleCount: 105,
      fullRolloutEligible: true,
    });
    expect(second).toMatchObject({ status: 'UNCHANGED', manifestHash: first.manifestHash });

    const db = await getDb();
    const [counts] = await db
      .select({
        entities: sql<number>`count(DISTINCT ${contentSources.sourceId})::int`,
        endpoints: sql<number>`count(DISTINCT ${contentSourceEndpoints.endpointId})::int`,
      })
      .from(contentSources)
      .leftJoin(
        contentSourceEndpoints,
        eq(contentSourceEndpoints.sourceId, contentSources.sourceId),
      )
      .where(eq(contentSources.origin, 'MANIFEST'));
    const [partitionCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourcePartitions);
    const [memberCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourcePartitionMembers);
    const [scheduleCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourceSchedules);
    const reconciliations = await db
      .select({ status: contentSourceRegistryReconciliations.status })
      .from(contentSourceRegistryReconciliations);

    expect(counts).toEqual({ entities: 85, endpoints: 108 });
    expect(partitionCount?.count).toBe(44);
    expect(memberCount?.count).toBe(87);
    expect(scheduleCount?.count).toBe(105);
    expect(reconciliations.map((row) => row.status).sort()).toEqual(['APPLIED', 'UNCHANGED']);
  });

  test('reapplies a previously seen manifest after a rollback', async () => {
    await resetBriefingAcquisitionState();
    const sourcesYaml = await Bun.file('config/briefing/sources.yaml').text();
    const acquisitionPlanYaml = await Bun.file('config/briefing/acquisition-plan.yaml').text();
    const original = parseBriefingManifest({ sourcesYaml, acquisitionPlanYaml });
    const changedSourcesYaml = sourcesYaml.replace(
      'displayName: Official FPL',
      'displayName: Official FPL temporary',
    );
    expect(changedSourcesYaml).not.toBe(sourcesYaml);
    const changed = parseBriefingManifest({
      sourcesYaml: changedSourcesYaml,
      acquisitionPlanYaml,
    });

    await reconcileBriefingSourceRegistry({ bundle: original, gitRevision: 'rollback-a' });
    await reconcileBriefingSourceRegistry({ bundle: changed, gitRevision: 'rollback-b' });
    const rolledBack = await reconcileBriefingSourceRegistry({
      bundle: original,
      gitRevision: 'rollback-a-again',
    });
    expect(rolledBack).toMatchObject({ status: 'APPLIED', manifestHash: original.manifestHash });

    const db = await getDb();
    const [source] = await db
      .select({
        displayName: contentSources.displayName,
        manifestRevision: contentSources.manifestRevision,
      })
      .from(contentSources)
      .where(eq(contentSources.sourceKey, 'official-fpl'));
    expect(source).toEqual({
      displayName: 'Official FPL',
      manifestRevision: original.manifestHash,
    });
  });

  test('atomically creates, reuses and revises a stable Receipt', async () => {
    await resetBriefingAcquisitionState();
    const bundle = await loadBriefingManifest();
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'receipt-revision-test' });
    const db = await getDb();
    const endpointRows = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        profileKey: contentSourceEndpoints.profileKey,
        scheduleId: contentSourceSchedules.scheduleId,
      })
      .from(contentSourceEndpoints)
      .innerJoin(
        contentSourceSchedules,
        eq(contentSourceSchedules.endpointId, contentSourceEndpoints.endpointId),
      )
      .where(eq(contentSourceEndpoints.endpointKey, 'fpl-focal-youtube'))
      .limit(1);
    const endpoint = endpointRows[0];
    expect(endpoint).toBeDefined();
    if (!endpoint) return;

    const baseBatch: AcquisitionBatchV1 = {
      schemaVersion: 1,
      endpointKey: endpoint.endpointKey,
      checkedAt: new Date().toISOString(),
      validator: {
        etag: null,
        lastModified: null,
        providerCursor: 'Xef37ImWz3M',
        cacheNotBefore: null,
      },
      transportBodyHash: '1'.repeat(64),
      items: [
        {
          endpointKey: endpoint.endpointKey,
          externalItemId: 'Xef37ImWz3M',
          canonicalUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
          sourceUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
          linkAvailability: 'DIRECT',
          publishedAt: '2026-08-20T10:00:00.000Z',
          updatedAt: null,
          title: 'FPL Focal test video',
          authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
          contentKind: 'VIDEO',
          body: { availability: 'METADATA_ONLY', text: null },
          media: [],
          transcript: {
            status: 'PENDING',
            language: null,
            trackKind: null,
            providerRevision: null,
            segments: [],
          },
        },
      ],
    };

    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(ne(contentSourceSchedules.endpointId, endpoint.endpointId));

    const createRun = async (): Promise<string> => {
      await db
        .update(contentSourceSchedules)
        .set({
          status: 'active',
          nextDueAt: new Date(Date.now() - 60_000),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(contentSourceSchedules.scheduleId, endpoint.scheduleId));
      const [claimed] = await claimDueFormalRuns({
        enabledAdapters: ['YOUTUBE_CHANNEL'],
        claimLimit: 1,
      });
      if (!claimed) throw new Error('YouTube feed run was not claimed');
      expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
      const begun = await beginFormalRun({ runId: claimed.runId });
      expect(begun.status).toBe('RUNNING');
      return claimed.runId;
    };

    const firstRunId = await createRun();
    const first = await persistAcquisitionResult({
      runId: firstRunId,
      state: 'COMPLETED',
      batches: [baseBatch],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(first).toMatchObject({
      state: 'COMPLETED',
      receiptCount: 1,
      revisionCount: 1,
      outboxCount: 1,
      checkpointAdvanced: true,
    });

    const secondRunId = await createRun();
    const second = await persistAcquisitionResult({
      runId: secondRunId,
      state: 'COMPLETED',
      batches: [baseBatch],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(second).toMatchObject({
      state: 'CHECKED_NO_CHANGE',
      revisionCount: 0,
      unchangedCount: 1,
      outboxCount: 0,
    });

    const metadataOnlyRights = {
      mode: 'PUBLIC_METADATA_ONLY',
      allowPublic: true,
      allowFullText: false,
      attributionRequired: true,
    };
    await db
      .update(contentSourceEndpoints)
      .set({ rightsPolicy: metadataOnlyRights })
      .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
    const rightsRefreshRunId = await createRun();
    const rightsRefresh = await persistAcquisitionResult({
      runId: rightsRefreshRunId,
      state: 'COMPLETED',
      batches: [baseBatch],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(rightsRefresh).toMatchObject({
      state: 'CHECKED_NO_CHANGE',
      revisionCount: 0,
      outboxCount: 0,
    });
    const [refreshedReceipt] = await db
      .select({ rightsPolicy: contentSourceReceipts.rightsPolicy })
      .from(contentSourceReceipts)
      .where(eq(contentSourceReceipts.externalId, 'Xef37ImWz3M'));
    expect(refreshedReceipt?.rightsPolicy).toEqual(metadataOnlyRights);

    const thirdRunId = await createRun();
    const third = await persistAcquisitionResult({
      runId: thirdRunId,
      state: 'COMPLETED',
      batches: [
        {
          ...baseBatch,
          items: [{ ...baseBatch.items[0]!, title: 'FPL Focal changed title' }],
        },
      ],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(third).toMatchObject({ revisionCount: 1, outboxCount: 1 });

    const [databaseCounts] = await db
      .select({
        receipts: sql<number>`count(DISTINCT ${contentSourceReceipts.receiptId})::int`,
        revisions: sql<number>`count(DISTINCT ${contentSourceReceiptRevisions.receiptRevisionId})::int`,
        observations: sql<number>`count(DISTINCT ${contentSourceObservations.observationId})::int`,
        outbox: sql<number>`count(DISTINCT ${contentPipelineOutbox.outboxId})::int`,
      })
      .from(contentSourceReceipts)
      .leftJoin(
        contentSourceReceiptRevisions,
        eq(contentSourceReceiptRevisions.receiptId, contentSourceReceipts.receiptId),
      )
      .leftJoin(
        contentSourceObservations,
        eq(contentSourceObservations.receiptId, contentSourceReceipts.receiptId),
      )
      .leftJoin(
        contentPipelineOutbox,
        eq(contentPipelineOutbox.receiptId, contentSourceReceipts.receiptId),
      );
    expect(databaseCounts).toEqual({ receipts: 1, revisions: 2, observations: 4, outbox: 2 });

    const revision = await db
      .select({ id: contentSourceReceiptRevisions.receiptRevisionId })
      .from(contentSourceReceiptRevisions)
      .limit(1);
    expect(revision[0]).toBeDefined();
    if (revision[0]) {
      await expect(
        (async () => {
          await db
            .update(contentSourceReceiptRevisions)
            .set({ bodyAvailability: 'FULL' })
            .where(eq(contentSourceReceiptRevisions.receiptRevisionId, revision[0].id));
        })(),
      ).rejects.toThrow();
    }
  });

  test('resets only schedules whose immutable acquisition contract changed', async () => {
    await resetBriefingAcquisitionState();
    const bundle = await loadBriefingManifest();
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'contract-reset-v1' });
    const db = await getDb();
    const [target] = await db
      .select({
        scheduleId: contentSourceSchedules.scheduleId,
        endpointId: contentSourceSchedules.endpointId,
      })
      .from(contentSourceSchedules)
      .where(eq(contentSourceSchedules.scheduleKey, 'endpoint-fantasy-football-scout-rss'));
    const [unrelated] = await db
      .select({ scheduleId: contentSourceSchedules.scheduleId })
      .from(contentSourceSchedules)
      .where(eq(contentSourceSchedules.scheduleKey, 'endpoint-fml-fpl-podcast'));
    if (!target?.endpointId || !unrelated) throw new Error('Contract reset schedules are missing');

    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(ne(contentSourceSchedules.scheduleId, target.scheduleId));
    await db
      .update(contentSourceSchedules)
      .set({ status: 'active', nextDueAt: new Date(Date.now() - 60_000) })
      .where(eq(contentSourceSchedules.scheduleId, target.scheduleId));
    const [activeRun] = await claimDueFormalRuns({ enabledAdapters: ['RSS_ATOM'], claimLimit: 1 });
    if (!activeRun) throw new Error('Target RSS run was not claimed');

    const oldCutoff = new Date(Date.now() - 2 * 60 * 60_000);
    const oldCompleted = new Date(Date.now() - 60 * 60_000);
    await db
      .update(contentSourceSchedules)
      .set({
        failureStreak: 2,
        circuitState: 'OPEN',
        probeAfter: new Date(Date.now() + 60 * 60_000),
        cacheNotBefore: new Date(Date.now() + 30 * 60_000),
        validator: { etag: 'old-target-etag' },
        checkpoint: { windowEnd: oldCompleted.toISOString() },
        bootstrapCutoffAt: oldCutoff,
        bootstrapCompletedAt: oldCompleted,
        underLimitStreak: 3,
      })
      .where(eq(contentSourceSchedules.scheduleId, target.scheduleId));

    const unrelatedNextDue = new Date(Date.now() + 4 * 60 * 60_000);
    const unrelatedCutoff = new Date(Date.now() - 4 * 60 * 60_000);
    const unrelatedCompleted = new Date(Date.now() - 3 * 60 * 60_000);
    await db
      .update(contentSourceSchedules)
      .set({
        nextDueAt: unrelatedNextDue,
        validator: { etag: 'keep-etag' },
        checkpoint: { windowEnd: unrelatedCompleted.toISOString() },
        bootstrapCutoffAt: unrelatedCutoff,
        bootstrapCompletedAt: unrelatedCompleted,
        cacheNotBefore: new Date(Date.now() + 20 * 60_000),
      })
      .where(eq(contentSourceSchedules.scheduleId, unrelated.scheduleId));

    const modifiedSources = structuredClone(bundle.sources);
    const modifiedEndpoint = modifiedSources.entities
      .flatMap((entity) => entity.endpoints)
      .find((endpoint) => endpoint.endpointKey === 'fantasy-football-scout-rss');
    if (!modifiedEndpoint) throw new Error('Fantasy Football Scout RSS endpoint is missing');
    modifiedEndpoint.locator.url =
      'https://www.fantasyfootballscout.co.uk/feed/?briefing-contract=v2';
    const modifiedBundle = parseBriefingManifest({
      sourcesYaml: JSON.stringify(modifiedSources),
      acquisitionPlanYaml: JSON.stringify(bundle.plan),
    });
    const reconcileStartedAt = Date.now();
    await reconcileBriefingSourceRegistry({
      bundle: modifiedBundle,
      gitRevision: 'contract-reset-v2',
    });

    const [resetTarget] = await db
      .select({
        nextDueAt: contentSourceSchedules.nextDueAt,
        leaseOwner: contentSourceSchedules.leaseOwner,
        leaseExpiresAt: contentSourceSchedules.leaseExpiresAt,
        failureStreak: contentSourceSchedules.failureStreak,
        circuitState: contentSourceSchedules.circuitState,
        probeAfter: contentSourceSchedules.probeAfter,
        cacheNotBefore: contentSourceSchedules.cacheNotBefore,
        validator: contentSourceSchedules.validator,
        checkpoint: contentSourceSchedules.checkpoint,
        bootstrapCompletedAt: contentSourceSchedules.bootstrapCompletedAt,
        bootstrapCutoffAt: contentSourceSchedules.bootstrapCutoffAt,
        underLimitStreak: contentSourceSchedules.underLimitStreak,
      })
      .from(contentSourceSchedules)
      .where(eq(contentSourceSchedules.scheduleId, target.scheduleId));
    expect(resetTarget).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
      failureStreak: 0,
      circuitState: 'CLOSED',
      probeAfter: null,
      cacheNotBefore: null,
      validator: {},
      checkpoint: {},
      bootstrapCompletedAt: null,
      underLimitStreak: 0,
    });
    // The authoritative reset timestamp comes from PostgreSQL's clock, which
    // can trail the application wall clock by a few milliseconds in the
    // disposable integration container.
    const minimumResetTime = reconcileStartedAt - 100;
    expect(resetTarget?.nextDueAt.getTime()).toBeGreaterThanOrEqual(minimumResetTime);
    expect(resetTarget?.bootstrapCutoffAt?.getTime() ?? 0).toBeGreaterThanOrEqual(minimumResetTime);

    const [preservedUnrelated] = await db
      .select({
        nextDueAt: contentSourceSchedules.nextDueAt,
        validator: contentSourceSchedules.validator,
        checkpoint: contentSourceSchedules.checkpoint,
        bootstrapCompletedAt: contentSourceSchedules.bootstrapCompletedAt,
        bootstrapCutoffAt: contentSourceSchedules.bootstrapCutoffAt,
      })
      .from(contentSourceSchedules)
      .where(eq(contentSourceSchedules.scheduleId, unrelated.scheduleId));
    expect(preservedUnrelated).toEqual({
      nextDueAt: unrelatedNextDue,
      validator: { etag: 'keep-etag' },
      checkpoint: { windowEnd: unrelatedCompleted.toISOString() },
      bootstrapCompletedAt: unrelatedCompleted,
      bootstrapCutoffAt: unrelatedCutoff,
    });
    const [invalidatedRun] = await db
      .select({
        status: contentAcquisitionRuns.status,
        failureClass: contentAcquisitionRuns.failureClass,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, activeRun.runId));
    expect(invalidatedRun).toEqual({
      status: 'FAILED',
      failureClass: 'MANIFEST_CONTRACT_CHANGED',
    });

    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(ne(contentSourceSchedules.scheduleId, target.scheduleId));
    await db
      .update(contentSourceSchedules)
      .set({ status: 'active', nextDueAt: new Date(Date.now() - 60_000) })
      .where(eq(contentSourceSchedules.scheduleId, target.scheduleId));
    const [replacementRun] = await claimDueFormalRuns({
      enabledAdapters: ['RSS_ATOM'],
      claimLimit: 1,
    });
    if (!replacementRun) throw new Error('Replacement RSS run was not claimed');
    const replacementRequest = await beginFormalRun({ runId: replacementRun.runId });
    expect(replacementRequest.request).toMatchObject({
      jobKind: 'FEED_POLL',
      endpoint: {
        locator: {
          url: 'https://www.fantasyfootballscout.co.uk/feed/?briefing-contract=v2',
        },
      },
      validator: { etag: null, lastModified: null },
      bootstrap: { enabled: true },
    });
  });
});
