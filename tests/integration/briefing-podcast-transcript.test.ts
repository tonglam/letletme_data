import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import type { HermesTranscriptClientLike } from '../../src/content/acquisition/hermes-transcript-client';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalHttpWorker } from '../../src/content/workers/formal-http.worker';
import { runFormalMediaWorker } from '../../src/content/workers/formal-media.worker';
import {
  contentAcquisitionBudgetReservations,
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
  podcastTranscriptEnabled: true,
  hermesTranscriptUrl: 'https://hermes.example.com/v1/transcripts',
  hermesTranscriptTokenPresent: true,
  hermesDailyAudioMinutes: 120,
};

function feedXml(input: { guid: string; publishedAt: string; transcriptUrl?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"
      xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
      xmlns:podcast="https://podcastindex.org/namespace/1.0">
      <channel><title>FML FPL</title><link>https://www.fmlfpl.com/</link>
        <item><guid>${input.guid}</guid><title>${input.guid}</title>
          <pubDate>${input.publishedAt}</pubDate><itunes:duration>00:01:00</itunes:duration>
          <enclosure url="https://example.com/${input.guid}.mp3" type="audio/mpeg" />
          ${
            input.transcriptUrl
              ? `<podcast:transcript url="${input.transcriptUrl}" type="text/vtt" />`
              : ''
          }
        </item>
      </channel>
    </rss>`;
}

async function claimPodcastFeed() {
  const [claimed] = await claimDueFormalRuns({
    enabledAdapters: ['PODCAST_FEED'],
    claimLimit: 1,
  });
  if (!claimed) throw new Error('Podcast feed run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
  return claimed;
}

test('upgrades Podcast receipts from pending to publisher and Hermes timestamped transcripts', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'podcast-transcript-test' });
  const db = await getDb();
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'fml-fpl-podcast'))
    .limit(1);
  if (!endpoint) throw new Error('FML FPL Podcast endpoint is missing');
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

  const publisherFeed = await claimPodcastFeed();
  const publisherPublishedAt = new Date(Date.now() - 2 * 60_000).toUTCString();
  const publisherDiscovery = await runFormalHttpWorker(publisherFeed.job, {
    flags,
    fetchImpl: async () =>
      new Response(
        feedXml({
          guid: 'publisher-episode',
          publishedAt: publisherPublishedAt,
          transcriptUrl: 'https://example.com/publisher-episode.vtt',
        }),
        { status: 200, headers: { 'content-type': 'application/rss+xml' } },
      ),
  });
  expect(publisherDiscovery).toMatchObject({
    status: 'COMPLETED',
    receiptCount: 1,
    triggeredJobCount: 1,
  });
  const [publisherChild] = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      targetReceiptId: contentAcquisitionRuns.targetReceiptId,
      targetReceiptRevisionId: contentAcquisitionRuns.targetReceiptRevisionId,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, publisherFeed.runId));
  if (!publisherChild) throw new Error('Publisher transcript child was not created');
  expect(publisherChild.targetReceiptId).not.toBeNull();
  expect(publisherChild.targetReceiptRevisionId).not.toBeNull();
  const publisherResult = await runFormalMediaWorker(
    { schemaVersion: 1, runId: publisherChild.runId },
    {
      flags,
      publisherFetch: async () =>
        new Response(
          'WEBVTT\n\n00:00:00.500 --> 00:00:03.000\nPublisher opening\n\n00:00:03.100 --> 00:00:08.000\nPublisher analysis\n',
          { status: 200, headers: { 'content-type': 'text/vtt' } },
        ),
    },
  );
  expect(publisherResult).toMatchObject({
    status: 'COMPLETED',
    revisionCount: 1,
    transcriptSource: 'PUBLISHER',
  });

  await db
    .update(contentSourceSchedules)
    .set({
      nextDueAt: new Date(Date.now() - 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(contentSourceSchedules.endpointId, endpoint.endpointId));
  const hermesFeed = await claimPodcastFeed();
  const hermesPublishedAt = new Date(Date.now() - 60_000).toUTCString();
  const hermesDiscovery = await runFormalHttpWorker(hermesFeed.job, {
    flags,
    fetchImpl: async () =>
      new Response(feedXml({ guid: 'hermes-episode', publishedAt: hermesPublishedAt }), {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
  });
  expect(hermesDiscovery).toMatchObject({
    status: 'COMPLETED',
    receiptCount: 1,
    triggeredJobCount: 1,
  });
  const [hermesChild] = await db
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.parentRunId, hermesFeed.runId));
  if (!hermesChild) throw new Error('Hermes transcript child was not created');
  const hermesClient: HermesTranscriptClientLike = {
    transcribe: async () => ({
      mediaHash: 'c'.repeat(64),
      engine: 'faster-whisper',
      modelRevision: 'base',
      optionsRevision: 'faster-whisper-v1',
      language: 'en',
      durationSeconds: 60,
      segments: [
        { startMs: 750, endMs: 30_000, text: 'Generated opening' },
        { startMs: 30_100, endMs: 59_000, text: 'Generated analysis' },
      ],
      chunkCount: 1,
      requestMetadataHash: 'd'.repeat(64),
      responseMetadataHash: 'e'.repeat(64),
      providerUnits: 60,
      durationMs: 1_000,
    }),
  };
  const hermesResult = await runFormalMediaWorker(
    { schemaVersion: 1, runId: hermesChild.runId },
    { flags, hermesClient },
  );
  expect(hermesResult).toMatchObject({
    status: 'COMPLETED',
    revisionCount: 1,
    transcriptSource: 'HERMES',
  });

  const receipts = await db
    .select({ receiptId: contentSourceReceipts.receiptId })
    .from(contentSourceReceipts)
    .where(eq(contentSourceReceipts.contentKind, 'EPISODE'));
  expect(receipts).toHaveLength(2);
  const revisions = await db
    .select({ receiptRevisionId: contentSourceReceiptRevisions.receiptRevisionId })
    .from(contentSourceReceiptRevisions);
  expect(revisions).toHaveLength(4);
  const transcripts = await db
    .select({
      status: contentSourceTranscriptRevisions.status,
      provider: contentSourceTranscriptRevisions.provider,
    })
    .from(contentSourceTranscriptRevisions);
  expect(transcripts).toEqual(
    expect.arrayContaining([
      { status: 'PROVIDED', provider: 'publisher' },
      { status: 'GENERATED', provider: 'hermes' },
    ]),
  );
  const segments = await db
    .select({ segmentHash: contentSourceTranscriptSegments.segmentHash })
    .from(contentSourceTranscriptSegments);
  expect(segments).toHaveLength(4);
  expect(segments.every((segment) => /^[0-9a-f]{64}$/.test(segment.segmentHash))).toBe(true);
  const hermesReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, hermesChild.runId));
  expect(hermesReservations).toEqual([{ status: 'COMMITTED' }]);
});
