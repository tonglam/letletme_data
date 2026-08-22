import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { asc, desc, eq, ne, sql } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { planTriggeredContentWork } from '../../src/content/acquisition/triggered-work-planner';
import { SupadataTranscriptClient } from '../../src/content/acquisition/supadata-transcript-client';
import { YouTubeMetadataClient } from '../../src/content/acquisition/youtube-metadata-client';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalHttpWorker } from '../../src/content/workers/formal-http.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionJobOutbox,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
  contentSourceTranscriptRevisions,
  contentSourceTranscriptSegments,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

const flags = {
  ...getContentRuntimeFlags(),
  pipelineEnabled: true,
  acquisitionShadowMode: true,
  httpAcquisitionEnabled: true,
  youtubeDiscoveryEnabled: true,
  youtubeNativeEnabled: true,
  youtubeGeneratedEnabled: true,
  youtubeDataApiKeyPresent: true,
  supadataApiKeyPresent: true,
  supadataDailyCreditLimit: 100,
  supadataJobPollIntervalMs: 1_000,
};

test('discovers, gates and resumes one asynchronous YouTube transcript without resubmission', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'youtube-transcript-test' });
  const db = await getDb();
  const endpointKey = 'fpl-focal-youtube';
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, endpointKey))
    .limit(1);
  if (!endpoint) throw new Error('FPL Focal YouTube endpoint is missing');
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

  const [feedRun] = await claimDueFormalRuns({
    enabledAdapters: ['YOUTUBE_CHANNEL'],
    claimLimit: 1,
  });
  if (!feedRun) throw new Error('YouTube feed run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: feedRun.runId })).toBe(true);
  const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
      <link rel="alternate" href="https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw" />
      <entry><yt:videoId>yA8S_bMekDU</yt:videoId><yt:channelId>UC72QokPHXQ9r98ROfNZmaDw</yt:channelId>
        <title>Async FPL video</title><published>${publishedAt}</published><updated>${publishedAt}</updated>
        <link rel="alternate" href="https://www.youtube.com/watch?v=yA8S_bMekDU" />
        <author><name>FPL Focal</name><uri>https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw</uri></author>
        <media:group><media:description>Feed description</media:description></media:group>
      </entry>
    </feed>`;
  const discovery = await runFormalHttpWorker(feedRun.job, {
    flags,
    fetchImpl: async () =>
      new Response(xml, { status: 200, headers: { 'content-type': 'application/atom+xml' } }),
  });
  expect(discovery).toMatchObject({
    status: 'COMPLETED',
    receiptCount: 1,
    revisionCount: 1,
    triggeredJobCount: 1,
  });

  const [metadataRun] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, feedRun.runId));
  if (!metadataRun) throw new Error('YouTube metadata child was not created');
  const youtubeMetadataClient = new YouTubeMetadataClient({
    apiKey: 'youtube-secret',
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    fetchImpl: async () =>
      Response.json({
        items: [
          {
            id: 'yA8S_bMekDU',
            snippet: {
              channelId: 'UC72QokPHXQ9r98ROfNZmaDw',
              title: 'Canonical async FPL video',
              description: 'Canonical description',
              publishedAt,
              liveBroadcastContent: 'none',
            },
            contentDetails: { duration: 'PT1M59S', caption: 'false' },
            status: { uploadStatus: 'processed', privacyStatus: 'public' },
          },
        ],
      }),
  });
  const metadata = await runFormalHttpWorker(
    { schemaVersion: 1, runId: metadataRun.runId },
    { flags, youtubeMetadataClient },
  );
  expect(metadata).toMatchObject({
    status: 'COMPLETED',
    revisionCount: 1,
    triggeredJobCount: 1,
  });

  const [transcriptRun] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, metadataRun.runId));
  if (!transcriptRun) throw new Error('YouTube transcript child was not created');
  let submitCalls = 0;
  let pollCalls = 0;
  const supadataClient = new SupadataTranscriptClient({
    apiKey: 'supadata-secret',
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/transcript/provider-job-1')) {
        pollCalls += 1;
        return new Response(
          JSON.stringify({
            status: 'completed',
            content: [
              { text: 'Generated opening', offset: 0, duration: 30_000, lang: 'en' },
              { text: 'Generated analysis', offset: 30_100, duration: 60_000, lang: 'en' },
            ],
            lang: 'en',
            availableLangs: ['en'],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-billable-requests': '1' },
          },
        );
      }
      submitCalls += 1;
      return new Response(JSON.stringify({ jobId: 'provider-job-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json', 'x-billable-requests': '1' },
      });
    },
  });
  const pending = await runFormalHttpWorker(
    { schemaVersion: 1, runId: transcriptRun.runId },
    { flags, supadataClient },
  );
  expect(pending.status).toBe('PROVIDER_PENDING');
  const [parked] = await db
    .select({
      status: contentAcquisitionRuns.status,
      providerJobId: contentAcquisitionRuns.providerJobId,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, transcriptRun.runId));
  expect(parked).toEqual({ status: 'PENDING', providerJobId: 'provider-job-1' });
  const [pollOutbox] = await db
    .select({
      deliveredAt: contentAcquisitionJobOutbox.deliveredAt,
      jobId: contentAcquisitionJobOutbox.jobId,
    })
    .from(contentAcquisitionJobOutbox)
    .where(eq(contentAcquisitionJobOutbox.runId, transcriptRun.runId));
  expect(pollOutbox?.deliveredAt).toBeNull();
  expect(pollOutbox?.jobId).toStartWith('content-provider-poll-');

  const completed = await runFormalHttpWorker(
    { schemaVersion: 1, runId: transcriptRun.runId },
    { flags, supadataClient },
  );
  expect(completed).toMatchObject({ status: 'COMPLETED', revisionCount: 1, outboxCount: 1 });
  expect({ submitCalls, pollCalls }).toEqual({ submitCalls: 1, pollCalls: 1 });

  const receipts = await db
    .select({ receiptId: contentSourceReceipts.receiptId })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.externalId, 'yA8S_bMekDU'));
  expect(receipts).toHaveLength(1);
  const revisions = await db
    .select({ revisionNumber: contentSourceReceiptRevisions.revisionNumber })
    .from(contentSourceReceiptRevisions)
    .where(eq(contentSourceReceiptRevisions.receiptId, receipts[0]!.receiptId))
    .orderBy(asc(contentSourceReceiptRevisions.revisionNumber));
  expect(revisions).toEqual([{ revisionNumber: 1 }, { revisionNumber: 2 }, { revisionNumber: 3 }]);
  const transcripts = await db
    .select({
      status: contentSourceTranscriptRevisions.status,
      provider: contentSourceTranscriptRevisions.provider,
      trackKind: contentSourceTranscriptRevisions.trackKind,
    })
    .from(contentSourceTranscriptRevisions);
  expect(transcripts).toEqual([{ status: 'PROVIDED', provider: 'supadata', trackKind: 'UNKNOWN' }]);
  const segments = await db
    .select({ ordinal: contentSourceTranscriptSegments.ordinal })
    .from(contentSourceTranscriptSegments);
  expect(segments).toHaveLength(2);
  const traces = await db
    .select({
      sequence: contentAcquisitionProviderTraces.sequence,
      terminalState: contentAcquisitionProviderTraces.terminalState,
    })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, transcriptRun.runId))
    .orderBy(asc(contentAcquisitionProviderTraces.sequence));
  expect(traces).toEqual([
    { sequence: 0, terminalState: 'SUBMITTED' },
    { sequence: 1, terminalState: 'COMPLETED' },
  ]);
  const reservations = await db
    .select({
      status: contentAcquisitionBudgetReservations.status,
      units: contentAcquisitionBudgetReservations.units,
    })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, transcriptRun.runId));
  expect(reservations).toEqual([{ status: 'COMMITTED', units: '2.000000' }]);
  const endpointHealth = await db.execute<{
    latestJobKind: string;
    latestRunStatus: string;
    pendingProviderJobCount: number;
  }>(sql`
    SELECT latest_job_kind AS "latestJobKind",
           latest_run_status AS "latestRunStatus",
           pending_provider_job_count AS "pendingProviderJobCount"
    FROM content.acquisition_endpoint_health
    WHERE endpoint_key = ${endpointKey}
  `);
  expect(endpointHealth[0]).toMatchObject({
    latestJobKind: 'YOUTUBE_TRANSCRIPT',
    latestRunStatus: 'COMPLETED',
    pendingProviderJobCount: 0,
  });
  const targetHealth = await db.execute<{
    transcriptStatus: string;
    providerJobPending: boolean;
    duplicateActiveSubmission: boolean;
    plannerSeen: boolean;
  }>(sql`
    SELECT transcript_status AS "transcriptStatus",
           provider_job_pending AS "providerJobPending",
           duplicate_active_submission AS "duplicateActiveSubmission",
           work_planner_checked_at IS NOT NULL AS "plannerSeen"
    FROM content.acquisition_triggered_work_health
    WHERE receipt_id = ${receipts[0]!.receiptId}::uuid
  `);
  expect(targetHealth[0]).toEqual({
    transcriptStatus: 'PROVIDED',
    providerJobPending: false,
    duplicateActiveSubmission: false,
    plannerSeen: false,
  });
});

test('plans the second native attempt and reclaims a stale triggered lease', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'youtube-retry-test' });
  const db = await getDb();
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'fpl-focal-youtube'))
    .limit(1);
  if (!endpoint) throw new Error('FPL Focal YouTube endpoint is missing');
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
  const [feedRun] = await claimDueFormalRuns({
    enabledAdapters: ['YOUTUBE_CHANNEL'],
    claimLimit: 1,
  });
  if (!feedRun) throw new Error('Retry fixture feed run was not claimed');
  const videoId = 'noCaption01';
  const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"
    xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
    <entry><yt:videoId>${videoId}</yt:videoId><yt:channelId>UC72QokPHXQ9r98ROfNZmaDw</yt:channelId>
      <title>No captions</title><published>${publishedAt}</published><updated>${publishedAt}</updated>
      <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}" />
      <author><name>FPL Focal</name><uri>https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw</uri></author>
      <media:group><media:description>No captions yet</media:description></media:group>
    </entry></feed>`;
  await runFormalHttpWorker(feedRun.job, {
    flags,
    fetchImpl: async () =>
      new Response(xml, { status: 200, headers: { 'content-type': 'application/atom+xml' } }),
  });
  const [metadataRun] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, feedRun.runId));
  if (!metadataRun) throw new Error('Retry fixture metadata run is missing');
  const metadataClient = new YouTubeMetadataClient({
    apiKey: 'youtube-secret',
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    fetchImpl: async () =>
      Response.json({
        items: [
          {
            id: videoId,
            snippet: {
              channelId: 'UC72QokPHXQ9r98ROfNZmaDw',
              title: 'No captions canonical',
              description: 'No captions canonical description',
              publishedAt,
              liveBroadcastContent: 'none',
            },
            contentDetails: { duration: 'PT2M', caption: 'false' },
            status: { uploadStatus: 'processed', privacyStatus: 'public' },
          },
        ],
      }),
  });
  await runFormalHttpWorker(
    { schemaVersion: 1, runId: metadataRun.runId },
    { flags, youtubeMetadataClient: metadataClient },
  );
  const [firstTranscript] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, metadataRun.runId));
  if (!firstTranscript) throw new Error('First native transcript run is missing');
  const unavailableClient = new SupadataTranscriptClient({
    apiKey: 'supadata-secret',
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: 'transcript-unavailable',
          message: 'Transcript Unavailable',
          details: 'No transcript is available for this video',
        }),
        {
          status: 206,
          headers: { 'content-type': 'application/json', 'x-billable-requests': '1' },
        },
      ),
  });
  const firstResult = await runFormalHttpWorker(
    { schemaVersion: 1, runId: firstTranscript.runId },
    { flags: { ...flags, youtubeGeneratedEnabled: false }, supadataClient: unavailableClient },
  );
  expect(firstResult.status).toBe('CONTENT_DEFERRED');
  const [firstRunState] = await db
    .select({ runMetrics: contentAcquisitionRuns.runMetrics })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, firstTranscript.runId));
  await db
    .update(contentAcquisitionRuns)
    .set({
      runMetrics: {
        ...(firstRunState?.runMetrics as Record<string, unknown>),
        nextEligibleAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    .where(eq(contentAcquisitionRuns.runId, firstTranscript.runId));
  const planned = await planTriggeredContentWork({
    flags: { ...flags, youtubeGeneratedEnabled: false },
  });
  expect(planned.byJobKind).toMatchObject({ YOUTUBE_TRANSCRIPT: 1 });
  const [plannerCursor] = await db
    .select({ checkedAt: contentSourceReceipts.workPlannerCheckedAt })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.externalId, videoId));
  expect(plannerCursor?.checkedAt).toBeInstanceOf(Date);
  const [secondTranscript] = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      requestSnapshot: contentAcquisitionRuns.requestSnapshot,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, firstTranscript.runId));
  if (!secondTranscript) throw new Error('Second native transcript run is missing');
  expect(secondTranscript.requestSnapshot).toMatchObject({ attemptStage: 'NATIVE_SECOND' });

  await db
    .update(contentAcquisitionRuns)
    .set({ status: 'RUNNING', leaseExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(contentAcquisitionRuns.runId, secondTranscript.runId));
  await db
    .update(contentAcquisitionJobOutbox)
    .set({ deliveredAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
    .where(eq(contentAcquisitionJobOutbox.runId, secondTranscript.runId));
  const reclaimed = await planTriggeredContentWork({
    flags: { ...flags, youtubeGeneratedEnabled: false },
  });
  expect(reclaimed.reclaimed).toBe(1);
  const [recoveredState] = await db
    .select({ status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, secondTranscript.runId));
  expect(recoveredState?.status).toBe('PENDING');

  const secondResult = await runFormalHttpWorker(
    { schemaVersion: 1, runId: secondTranscript.runId },
    { flags: { ...flags, youtubeGeneratedEnabled: false }, supadataClient: unavailableClient },
  );
  expect(secondResult).toMatchObject({ status: 'CONTENT_DEFERRED', revisionCount: 1 });
  const [receipt] = await db
    .select({ receiptId: contentSourceReceipts.receiptId })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.externalId, videoId));
  if (!receipt) throw new Error('Retry fixture receipt is missing');
  const [currentTranscript] = await db
    .select({ status: contentSourceTranscriptRevisions.status })
    .from(contentSourceTranscriptRevisions)
    .innerJoin(
      contentSourceReceiptRevisions,
      eq(
        contentSourceReceiptRevisions.receiptRevisionId,
        contentSourceTranscriptRevisions.receiptRevisionId,
      ),
    )
    .where(eq(contentSourceReceiptRevisions.receiptId, receipt.receiptId))
    .orderBy(desc(contentSourceReceiptRevisions.revisionNumber))
    .limit(1);
  expect(currentTranscript?.status).toBe('DEFERRED');
  const [secondRunState] = await db
    .select({ runMetrics: contentAcquisitionRuns.runMetrics })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, secondTranscript.runId));
  await db
    .update(contentAcquisitionRuns)
    .set({
      runMetrics: {
        ...(secondRunState?.runMetrics as Record<string, unknown>),
        nextEligibleAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    .where(eq(contentAcquisitionRuns.runId, secondTranscript.runId));

  const makeLatestGeneratedRunFailed = async (input?: { providerJobId?: string }) => {
    const transcriptRuns = await db
      .select({
        runId: contentAcquisitionRuns.runId,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.targetReceiptId, receipt.receiptId))
      .orderBy(desc(contentAcquisitionRuns.createdAt));
    const generated = transcriptRuns.find(
      (run) => (run.requestSnapshot as Record<string, unknown>).attemptStage === 'GENERATED',
    );
    if (!generated) throw new Error('Generated transcript run is missing');
    await db
      .update(contentAcquisitionRuns)
      .set({
        status: 'FAILED',
        completedAt: new Date(Date.now() - 10 * 60_000),
        provider: input?.providerJobId ? 'supadata' : null,
        providerJobId: input?.providerJobId ?? null,
        runMetrics: input?.providerJobId ? { providerPollRecoveries: 2 } : {},
      })
      .where(eq(contentAcquisitionRuns.runId, generated.runId));
    return generated.runId;
  };

  const generatedPlan = await planTriggeredContentWork({ flags });
  expect(generatedPlan.byJobKind).toMatchObject({ YOUTUBE_TRANSCRIPT: 1 });
  await makeLatestGeneratedRunFailed();
  expect((await planTriggeredContentWork({ flags })).byJobKind).toMatchObject({
    YOUTUBE_TRANSCRIPT: 1,
  });
  await makeLatestGeneratedRunFailed();
  expect((await planTriggeredContentWork({ flags })).byJobKind).toMatchObject({
    YOUTUBE_TRANSCRIPT: 1,
  });
  const exhaustedRunId = await makeLatestGeneratedRunFailed({ providerJobId: 'stuck-job' });
  const exhaustedPlan = await planTriggeredContentWork({ flags });
  expect(exhaustedPlan.planned).toBe(0);
  const [exhausted] = await db
    .select({
      failureClass: contentAcquisitionRuns.failureClass,
      runMetrics: contentAcquisitionRuns.runMetrics,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, exhaustedRunId));
  expect(exhausted).toMatchObject({
    failureClass: 'PROVIDER_POLL_RETRY_EXHAUSTED',
    runMetrics: { providerPollTerminalState: 'POLL_RETRY_EXHAUSTED' },
  });
  const generatedRuns = await db
    .select({ requestSnapshot: contentAcquisitionRuns.requestSnapshot })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.targetReceiptId, receipt.receiptId));
  expect(
    generatedRuns.filter(
      (run) => (run.requestSnapshot as Record<string, unknown>).attemptStage === 'GENERATED',
    ),
  ).toHaveLength(3);
});

test('rejects a stale billable transcript result without overwriting the current receipt', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'youtube-stale-result-test' });
  const db = await getDb();
  const endpointKey = 'fpl-focal-youtube';
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, endpointKey))
    .limit(1);
  if (!endpoint) throw new Error('FPL Focal YouTube endpoint is missing');
  await db
    .update(contentSourceSchedules)
    .set({ status: 'paused' })
    .where(ne(contentSourceSchedules.endpointId, endpoint.endpointId));
  await db
    .update(contentSourceSchedules)
    .set({ status: 'active', nextDueAt: new Date(Date.now() - 60_000) })
    .where(eq(contentSourceSchedules.endpointId, endpoint.endpointId));

  const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const videoId = 'staleResult01';
  const feedXml = (
    title: string,
    description: string,
    updatedAt = publishedAt,
  ) => `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
      <entry><yt:videoId>${videoId}</yt:videoId><yt:channelId>UC72QokPHXQ9r98ROfNZmaDw</yt:channelId>
        <title>${title}</title><published>${publishedAt}</published><updated>${updatedAt}</updated>
        <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}" />
        <author><name>FPL Focal</name><uri>https://www.youtube.com/channel/UC72QokPHXQ9r98ROfNZmaDw</uri></author>
        <media:group><media:description>${description}</media:description></media:group>
      </entry>
    </feed>`;

  const [feedRun] = await claimDueFormalRuns({
    enabledAdapters: ['YOUTUBE_CHANNEL'],
    claimLimit: 1,
  });
  if (!feedRun) throw new Error('Initial stale-result feed run was not claimed');
  await runFormalHttpWorker(feedRun.job, {
    flags,
    fetchImpl: async () =>
      new Response(feedXml('Initial title', 'Initial description'), {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' },
      }),
  });
  const [initialSchedule] = await db
    .select({ checkpoint: contentSourceSchedules.checkpoint })
    .from(contentSourceSchedules)
    .where(eq(contentSourceSchedules.endpointId, endpoint.endpointId));
  const initialCheckedAt = new Date(
    String((initialSchedule?.checkpoint as Record<string, unknown> | null)?.checkedAt ?? ''),
  );
  if (!Number.isFinite(initialCheckedAt.getTime())) {
    throw new Error('Initial stale-result checkpoint is missing checkedAt');
  }
  const [metadataRun] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, feedRun.runId));
  if (!metadataRun) throw new Error('Stale-result metadata run is missing');
  await runFormalHttpWorker(
    { schemaVersion: 1, runId: metadataRun.runId },
    {
      flags,
      youtubeMetadataClient: new YouTubeMetadataClient({
        apiKey: 'youtube-secret',
        timeoutMs: 1_000,
        maximumResponseBytes: 1_000_000,
        fetchImpl: async () =>
          Response.json({
            items: [
              {
                id: videoId,
                snippet: {
                  channelId: 'UC72QokPHXQ9r98ROfNZmaDw',
                  title: 'Canonical initial title',
                  description: 'Canonical initial description',
                  publishedAt,
                  liveBroadcastContent: 'none',
                },
                contentDetails: { duration: 'PT2M', caption: 'true' },
                status: { uploadStatus: 'processed', privacyStatus: 'public' },
              },
            ],
          }),
      }),
    },
  );
  const [transcriptRun] = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      targetReceiptRevisionId: contentAcquisitionRuns.targetReceiptRevisionId,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, metadataRun.runId));
  if (!transcriptRun?.targetReceiptRevisionId) {
    throw new Error('Stale-result transcript run is missing its target revision');
  }

  await db
    .update(contentSourceSchedules)
    .set({
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(contentSourceSchedules.endpointId, endpoint.endpointId));
  const [refreshRun] = await claimDueFormalRuns({
    enabledAdapters: ['YOUTUBE_CHANNEL'],
    claimLimit: 1,
  });
  if (!refreshRun) throw new Error('Refresh feed run was not claimed');
  await runFormalHttpWorker(refreshRun.job, {
    flags,
    fetchImpl: async () =>
      new Response(
        feedXml(
          'Newer feed title',
          'Newer feed description',
          new Date(initialCheckedAt.getTime() + 1).toISOString(),
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/atom+xml' },
        },
      ),
  });
  const [receiptBefore] = await db
    .select({
      receiptId: contentSourceReceipts.receiptId,
      currentRevisionId: contentSourceReceipts.currentRevisionId,
      payload: contentSourceReceipts.payload,
    })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.externalId, videoId));
  if (!receiptBefore?.currentRevisionId) throw new Error('Stale-result receipt is missing');
  expect(receiptBefore.currentRevisionId).not.toBe(transcriptRun.targetReceiptRevisionId);

  const billableClient = new SupadataTranscriptClient({
    apiKey: 'supadata-secret',
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          content: [{ text: 'Old transcript content', offset: 0, duration: 1_000, lang: 'en' }],
          lang: 'en',
          availableLangs: ['en'],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-billable-requests': '3' },
        },
      ),
  });
  await expect(
    runFormalHttpWorker(
      { schemaVersion: 1, runId: transcriptRun.runId },
      { flags, supadataClient: billableClient },
    ),
  ).rejects.toThrow('STALE_TARGET_RECEIPT_REVISION');

  const [receiptAfter] = await db
    .select({
      currentRevisionId: contentSourceReceipts.currentRevisionId,
      payload: contentSourceReceipts.payload,
    })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.receiptId, receiptBefore.receiptId));
  expect(receiptAfter?.currentRevisionId).toBe(receiptBefore.currentRevisionId);
  expect(receiptAfter?.payload).toEqual(receiptBefore.payload);
  const [failedRun] = await db
    .select({
      status: contentAcquisitionRuns.status,
      failureClass: contentAcquisitionRuns.failureClass,
      providerUnits: contentAcquisitionRuns.providerUnits,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, transcriptRun.runId));
  expect(failedRun).toEqual({
    status: 'FAILED',
    failureClass: 'STALE_TARGET_RECEIPT_REVISION',
    providerUnits: '3.000000',
  });
  const [reservation] = await db
    .select({
      status: contentAcquisitionBudgetReservations.status,
      units: contentAcquisitionBudgetReservations.units,
    })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, transcriptRun.runId));
  expect(reservation).toEqual({ status: 'COMMITTED', units: '3.000000' });
  const [trace] = await db
    .select({
      providerUnits: contentAcquisitionProviderTraces.providerUnits,
      terminalState: contentAcquisitionProviderTraces.terminalState,
    })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, transcriptRun.runId));
  expect(trace).toEqual({
    providerUnits: '3.000000',
    terminalState: 'FAILED:STALE_TARGET_RECEIPT_REVISION',
  });
});
