import { sql } from 'drizzle-orm';

import type { AcquisitionBatchV1, AcquisitionItemV1 } from '../acquisition/acquisition-contract';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import {
  beginFormalRun,
  deferFormalRunForBudget,
  failFormalRun,
} from '../acquisition/formal-run-repository';
import {
  HermesTranscriptClient,
  type HermesTranscriptClientLike,
} from '../acquisition/hermes-transcript-client';
import type { PublicFetch } from '../acquisition/http-transport';
import { reserveHermesAudioBudget } from '../acquisition/media-budget';
import {
  fetchPublisherPodcastTranscript,
  publisherTranscriptHttpTrace,
} from '../acquisition/podcast-transcript-adapter';
import { persistAcquisitionResult } from '../acquisition/receipt-repository';
import { getContentRuntimeFlags, type ContentRuntimeFlags } from '../config';
import { getDb, type DbHandle } from '../../db/singleton';

export type FormalMediaWorkerResult = Readonly<{
  runId: string;
  status: 'REUSED' | 'COMPLETED' | 'BUDGET_DEFERRED';
  receiptCount: number;
  revisionCount: number;
  outboxCount: number;
  transcriptSource: 'PUBLISHER' | 'HERMES' | null;
}>;

function errorFacts(error: unknown): { failureClass: string; summary: string } {
  const candidate = error as { failureClass?: unknown; message?: unknown };
  return {
    failureClass:
      typeof candidate?.failureClass === 'string'
        ? candidate.failureClass
        : 'MEDIA_TRANSCRIPT_FAILED',
    summary:
      typeof candidate?.message === 'string'
        ? candidate.message
        : 'Formal media transcript adapter failed',
  };
}

async function databaseNow(db: DbHandle): Promise<Date> {
  const rows = await db.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
  const result = new Date(rows[0]?.dbNow ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

function resultBatch(input: {
  item: AcquisitionItemV1;
  checkedAt: Date;
  transportBodyHash: string | null;
}): AcquisitionBatchV1 {
  return {
    schemaVersion: 1,
    endpointKey: input.item.endpointKey,
    checkedAt: input.checkedAt.toISOString(),
    validator: {
      etag: null,
      lastModified: null,
      providerCursor: null,
      cacheNotBefore: null,
    },
    transportBodyHash: input.transportBodyHash,
    items: [input.item],
  };
}

function evidenceKey(item: AcquisitionItemV1): string {
  return `${item.endpointKey}\u0000${item.externalItemId}`;
}

export async function runFormalMediaWorker(
  rawJob: AcquisitionJobV1,
  dependencies?: Readonly<{
    flags?: ContentRuntimeFlags;
    publisherFetch?: PublicFetch;
    hermesClient?: HermesTranscriptClientLike;
    db?: DbHandle;
  }>,
): Promise<FormalMediaWorkerResult> {
  const job = acquisitionJobV1Schema.parse(rawJob);
  const flags = dependencies?.flags ?? getContentRuntimeFlags();
  const db = dependencies?.db ?? (await getDb());
  let began = false;
  let hermesProviderAttempted = false;
  let hermesProviderUnits: number | undefined;
  try {
    const run = await beginFormalRun({ runId: job.runId, db });
    if (run.status === 'TERMINAL') {
      return {
        runId: job.runId,
        status: 'REUSED',
        receiptCount: 0,
        revisionCount: 0,
        outboxCount: 0,
        transcriptSource: null,
      };
    }
    began = true;
    if (
      !flags.pipelineEnabled ||
      !flags.httpAcquisitionEnabled ||
      !flags.podcastTranscriptEnabled
    ) {
      throw new Error('Formal Podcast transcript acquisition is disabled');
    }
    if (run.request.jobKind !== 'PODCAST_TRANSCRIPT') {
      throw new Error(`Media worker cannot execute ${run.request.jobKind}`);
    }
    const request = run.request;
    const checkedAt = await databaseNow(db);
    const publisher = await fetchPublisherPodcastTranscript({
      item: request.discoveryItem,
      timeoutMs: flags.httpTimeoutMs,
      maximumBytes: request.policy.publisherTranscriptMaximumBytes,
      fetchImpl: dependencies?.publisherFetch,
    });
    if (publisher) {
      const item: AcquisitionItemV1 = {
        ...request.discoveryItem,
        transcript: {
          status: 'PROVIDED',
          language: publisher.language,
          trackKind: 'UNKNOWN',
          providerRevision: publisher.providerRevision,
          segments: [...publisher.segments],
        },
      };
      const persisted = await persistAcquisitionResult({
        runId: job.runId,
        state: 'COMPLETED',
        batches: [
          resultBatch({ item, checkedAt, transportBodyHash: publisher.transport.bodyHash }),
        ],
        checkpointComplete: false,
        transcriptEvidence: {
          [evidenceKey(item)]: {
            provider: 'publisher',
            engine: 'timed-text-parser',
            modelRevision: null,
            optionsRevision: publisher.providerRevision,
            mediaHash: publisher.artifactHash,
          },
        },
        httpTraces: [
          {
            sequence: 0,
            operation: 'podcast.publisher-transcript.fetch',
            ...publisherTranscriptHttpTrace(publisher.transport),
          },
        ],
        runMetrics: {
          transcriptSource: 'PUBLISHER',
          segmentCount: publisher.segments.length,
          artifactAttemptCount: publisher.artifactAttemptCount,
        },
        db,
      });
      return {
        runId: job.runId,
        status: 'COMPLETED',
        receiptCount: persisted.receiptCount,
        revisionCount: persisted.revisionCount,
        outboxCount: persisted.outboxCount,
        transcriptSource: 'PUBLISHER',
      };
    }

    const audio = [...request.discoveryItem.media]
      .filter((media) => media.kind === 'AUDIO')
      .sort((left, right) => left.url.localeCompare(right.url))[0];
    if (!audio || audio.durationSeconds === null) {
      throw new Error('Podcast Hermes fallback requires a duration-bearing audio enclosure');
    }
    if (audio.durationSeconds > request.policy.maximumDurationSeconds) {
      throw new Error('Podcast audio exceeds the versioned Hermes duration cap');
    }
    const budget = await reserveHermesAudioBudget({
      runId: job.runId,
      audioSeconds: audio.durationSeconds,
      dailyAudioMinutes: flags.hermesDailyAudioMinutes,
      db,
    });
    if (!budget.reserved) {
      await deferFormalRunForBudget({
        runId: job.runId,
        metrics: {
          provider: 'hermes',
          requestedAudioSeconds: Math.ceil(audio.durationSeconds),
          remainingAudioSeconds: budget.remainingSecondsBeforeReservation,
        },
        db,
      });
      return {
        runId: job.runId,
        status: 'BUDGET_DEFERRED',
        receiptCount: 0,
        revisionCount: 0,
        outboxCount: 0,
        transcriptSource: null,
      };
    }
    const hermesClient =
      dependencies?.hermesClient ??
      new HermesTranscriptClient({
        endpoint: flags.hermesTranscriptUrl ?? '',
        token: process.env.HERMES_TRANSCRIPT_TOKEN ?? '',
        timeoutMs: flags.hermesTranscriptTimeoutMs,
        maximumResponseBytes: flags.hermesTranscriptMaxOutputBytes,
      });
    hermesProviderAttempted = true;
    hermesProviderUnits = Math.ceil(audio.durationSeconds);
    const execution = await hermesClient.transcribe({
      runId: job.runId,
      externalItemId: request.discoveryItem.externalItemId,
      mediaUrl: audio.url,
      expectedDurationSeconds: audio.durationSeconds,
      chunkDurationSeconds: request.policy.chunkDurationSeconds,
    });
    const item: AcquisitionItemV1 = {
      ...request.discoveryItem,
      transcript: {
        status: 'GENERATED',
        language: execution.language,
        trackKind: 'AUTO',
        providerRevision: `${execution.engine}:${execution.modelRevision}:${execution.optionsRevision}`,
        segments: [...execution.segments],
      },
    };
    const persisted = await persistAcquisitionResult({
      runId: job.runId,
      state: 'COMPLETED',
      batches: [resultBatch({ item, checkedAt, transportBodyHash: null })],
      checkpointComplete: false,
      transcriptEvidence: {
        [evidenceKey(item)]: {
          provider: 'hermes',
          engine: execution.engine,
          modelRevision: execution.modelRevision,
          optionsRevision: execution.optionsRevision,
          mediaHash: execution.mediaHash,
        },
      },
      providerTraces: [
        {
          sequence: 0,
          provider: 'hermes',
          operation: 'podcast.transcribe',
          requestMetadataHash: execution.requestMetadataHash,
          responseMetadataHash: execution.responseMetadataHash,
          providerJobIdHash: null,
          providerUnits: execution.providerUnits,
          terminalState: 'COMPLETED',
        },
      ],
      providerResult: { provider: 'hermes', providerUnits: execution.providerUnits },
      runMetrics: {
        transcriptSource: 'HERMES',
        durationMs: execution.durationMs,
        durationSeconds: execution.durationSeconds,
        segmentCount: execution.segments.length,
        chunkCount: execution.chunkCount,
      },
      db,
    });
    return {
      runId: job.runId,
      status: 'COMPLETED',
      receiptCount: persisted.receiptCount,
      revisionCount: persisted.revisionCount,
      outboxCount: persisted.outboxCount,
      transcriptSource: 'HERMES',
    };
  } catch (error) {
    if (began) {
      const failure = errorFacts(error);
      await failFormalRun({
        runId: job.runId,
        failureClass: failure.failureClass,
        errorSummary: failure.summary,
        hermesProviderAttempted,
        hermesProviderUnits,
        db,
      });
    }
    throw error;
  }
}
