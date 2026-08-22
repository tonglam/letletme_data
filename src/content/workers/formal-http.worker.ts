import { sql } from 'drizzle-orm';

import type { AcquisitionBatchV1, AcquisitionItemV1 } from '../acquisition/acquisition-contract';
import type { PublicFetch } from '../acquisition/http-transport';

import { getContentRuntimeFlags, type ContentRuntimeFlags } from '../config';
import {
  ARTICLE_PROFILE_KEY,
  ARTICLE_PROFILE_REVISION,
  articleHttpTraces,
  runArticleAdapter,
} from '../acquisition/article-adapter';
import { getAcquisitionProfile } from '../acquisition/acquisition-profiles';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import {
  beginFormalRun,
  deferFormalRunForBudget,
  failFormalRun,
  parkFormalRunForProviderPoll,
} from '../acquisition/formal-run-repository';
import { feedHttpTrace, runFeedAdapter } from '../acquisition/feed-adapter';
import { PODCAST_TRANSCRIPT_POLICY_V1 } from '../acquisition/podcast-transcript-adapter';
import { reserveSupadataCreditBudget } from '../acquisition/media-budget';
import { persistAcquisitionResult } from '../acquisition/receipt-repository';
import {
  SUPADATA_PROVIDER_REVISION,
  SupadataTranscriptClient,
  type SupadataPollResult,
  type SupadataSubmitResult,
  type SupadataTranscriptClientLike,
} from '../acquisition/supadata-transcript-client';
import {
  YouTubeMetadataClient,
  YOUTUBE_METADATA_POLICY_V1,
  YOUTUBE_TRANSCRIPT_POLICY_V1,
  type YouTubeMetadataClientLike,
} from '../acquisition/youtube-metadata-client';
import { getDb, type DbHandle } from '../../db/singleton';

export type FormalHttpWorkerResult = Readonly<{
  runId: string;
  status:
    | 'REUSED'
    | 'EMPTY'
    | 'CHECKED_NO_CHANGE'
    | 'COMPLETED'
    | 'PARTIAL'
    | 'SATURATED'
    | 'GAP'
    | 'CONTENT_DEFERRED'
    | 'BUDGET_DEFERRED'
    | 'PROVIDER_PENDING'
    | 'FAILED';
  receiptCount: number;
  revisionCount: number;
  outboxCount: number;
  triggeredJobCount: number;
}>;

function errorFacts(error: unknown): { failureClass: string; summary: string } {
  const candidate = error as { failureClass?: unknown; message?: unknown };
  return {
    failureClass:
      typeof candidate?.failureClass === 'string' ? candidate.failureClass : 'ADAPTER_FAILED',
    summary:
      typeof candidate?.message === 'string' ? candidate.message : 'Formal HTTP adapter failed',
  };
}

function nextDueAt(input: {
  checkedAt: string;
  cadenceMinutes: number;
  cacheNotBefore: string | null;
}): Date {
  const cadence = new Date(Date.parse(input.checkedAt) + input.cadenceMinutes * 60_000);
  const cache = input.cacheNotBefore ? new Date(input.cacheNotBefore) : null;
  return cache && cache > cadence ? cache : cadence;
}

async function databaseNow(db: DbHandle): Promise<Date> {
  const rows = await db.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
  const result = new Date(rows[0]?.dbNow ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

function resultBatch(item: AcquisitionItemV1, checkedAt: Date): AcquisitionBatchV1 {
  return {
    schemaVersion: 1,
    endpointKey: item.endpointKey,
    checkedAt: checkedAt.toISOString(),
    validator: {
      etag: null,
      lastModified: null,
      providerCursor: null,
      cacheNotBefore: null,
    },
    transportBodyHash: null,
    items: [item],
  };
}

function transcriptEvidenceKey(item: AcquisitionItemV1): string {
  return `${item.endpointKey}\u0000${item.externalItemId}`;
}

function finishedAt(item: AcquisitionItemV1): Date | null {
  const value = item.video?.actualEndAt ?? item.publishedAt;
  if (!value) return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function assertFeedEnabled(
  adapterKind: 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL',
  flags: ContentRuntimeFlags,
): void {
  if (!flags.pipelineEnabled || !flags.httpAcquisitionEnabled) {
    throw new Error('Formal HTTP acquisition is disabled');
  }
  if (adapterKind === 'YOUTUBE_CHANNEL' && !flags.youtubeDiscoveryEnabled) {
    throw new Error('YouTube discovery is disabled');
  }
}

export async function runFormalHttpWorker(
  rawJob: AcquisitionJobV1,
  dependencies?: Readonly<{
    flags?: ContentRuntimeFlags;
    fetchImpl?: PublicFetch;
    youtubeMetadataClient?: YouTubeMetadataClientLike;
    supadataClient?: SupadataTranscriptClientLike;
    db?: DbHandle;
  }>,
): Promise<FormalHttpWorkerResult> {
  const job = acquisitionJobV1Schema.parse(rawJob);
  const flags = dependencies?.flags ?? getContentRuntimeFlags();
  let began = false;
  try {
    const run = await beginFormalRun({ runId: job.runId, db: dependencies?.db });
    if (run.status === 'TERMINAL') {
      return {
        runId: job.runId,
        status: 'REUSED',
        receiptCount: 0,
        revisionCount: 0,
        outboxCount: 0,
        triggeredJobCount: 0,
      };
    }
    began = true;

    if (run.request.jobKind === 'FEED_POLL') {
      const request = run.request;
      assertFeedEnabled(request.adapterKind, flags);
      const profile = getAcquisitionProfile(request.profileKey);
      if (
        !profile ||
        profile.revision !== request.profileRevision ||
        profile.adapterKind !== request.adapterKind
      ) {
        throw new Error('Persisted feed profile no longer matches versioned code');
      }
      const result = await runFeedAdapter({
        endpointKey: request.endpoint.endpointKey,
        adapterKind: request.adapterKind,
        profileKey: request.profileKey,
        locator: request.endpoint.locator,
        validator: request.validator,
        bootstrapProfile: request.bootstrap.enabled ? profile : undefined,
        bootstrapCutoffAt: request.bootstrap.enabled
          ? new Date(request.bootstrap.cutoffAt)
          : undefined,
        fetchImpl: dependencies?.fetchImpl,
        timeoutMs: flags.httpTimeoutMs,
        maximumBytes: flags.httpMaxOutputBytes,
      });
      if (result.rejections.length > 0 && result.batch.items.length === 0) {
        throw new Error('Feed parser rejected every in-scope item');
      }
      const state =
        result.rejections.length > 0 && result.batch.items.length > 0
          ? ('PARTIAL' as const)
          : result.stateHint;
      const checkpointComplete = state !== 'PARTIAL';
      const feedOrigin = new URL(result.transport.finalUrl).origin;
      const articleItems = result.batch.items
        .filter(
          (item) =>
            item.contentKind === 'ARTICLE' &&
            item.body.availability !== 'FULL' &&
            item.linkAvailability === 'DIRECT' &&
            item.sourceUrl !== null &&
            new URL(item.sourceUrl).origin === feedOrigin,
        )
        .slice(0, request.bootstrap.maxContentJobs);
      const podcastItems = flags.podcastTranscriptEnabled
        ? result.batch.items
            .filter(
              (item) =>
                item.contentKind === 'EPISODE' &&
                item.transcript.status === 'PENDING' &&
                item.media.some((media) => media.kind === 'AUDIO'),
            )
            .slice(0, request.bootstrap.maxContentJobs)
        : [];
      const youtubeItems = flags.youtubeNativeEnabled
        ? result.batch.items
            .filter((item) => item.contentKind === 'VIDEO' && item.transcript.status === 'PENDING')
            .slice(0, request.bootstrap.maxContentJobs)
        : [];
      const persisted = await persistAcquisitionResult({
        runId: job.runId,
        state,
        batches: [result.batch],
        rejections: result.rejections.map((rejection) => ({
          endpointKey: request.endpoint.endpointKey,
          ...rejection,
        })),
        checkpointComplete,
        checkpoint: checkpointComplete
          ? {
              checkedAt: result.batch.checkedAt,
              windowEnd: request.windowEnd,
              newestExternalItemId: result.batch.items[0]?.externalItemId ?? null,
            }
          : undefined,
        nextDueAt: nextDueAt({
          checkedAt: result.batch.checkedAt,
          cadenceMinutes: profile.cadenceMinutes[request.phase],
          cacheNotBefore: result.transport.cacheNotBefore,
        }),
        bootstrapCompleted: request.bootstrap.enabled && checkpointComplete,
        endpointIdentityEvidence:
          request.adapterKind === 'YOUTUBE_CHANNEL'
            ? undefined
            : {
                [request.endpoint.endpointKey]: {
                  stableExternalId: result.transport.finalUrl,
                },
              },
        triggeredJobs: [
          ...articleItems.map((item) => ({
            queueName: 'content-http-acquisition' as const,
            priority: profile.priority,
            request: {
              schemaVersion: 1 as const,
              jobKind: 'ARTICLE_FETCH' as const,
              adapterKind: 'ARTICLE_HTTP' as const,
              phase: request.phase,
              profileKey: ARTICLE_PROFILE_KEY,
              profileRevision: ARTICLE_PROFILE_REVISION,
              windowStart: result.batch.checkedAt,
              windowEnd: result.batch.checkedAt,
              endpoint: request.endpoint,
              discoveryItem: item,
              allowedOrigins: [feedOrigin],
              validator: { etag: null, lastModified: null },
            },
          })),
          ...podcastItems.map((item) => ({
            queueName: 'content-media-transcript' as const,
            priority: profile.priority,
            request: {
              schemaVersion: 1 as const,
              jobKind: 'PODCAST_TRANSCRIPT' as const,
              adapterKind: 'HERMES_TRANSCRIPT' as const,
              phase: request.phase,
              profileKey: request.profileKey,
              profileRevision: request.profileRevision,
              windowStart: result.batch.checkedAt,
              windowEnd: result.batch.checkedAt,
              endpoint: request.endpoint,
              discoveryItem: item,
              policy: PODCAST_TRANSCRIPT_POLICY_V1,
            },
          })),
          ...youtubeItems.map((item) => ({
            queueName: 'content-http-acquisition' as const,
            priority: profile.priority,
            request: {
              schemaVersion: 1 as const,
              jobKind: 'YOUTUBE_METADATA' as const,
              adapterKind: 'YOUTUBE_CHANNEL' as const,
              phase: request.phase,
              profileKey: request.profileKey,
              profileRevision: request.profileRevision,
              windowStart: result.batch.checkedAt,
              windowEnd: result.batch.checkedAt,
              endpoint: request.endpoint,
              discoveryItem: item,
              policy: YOUTUBE_METADATA_POLICY_V1,
            },
          })),
        ],
        httpTraces: [{ operation: 'feed.fetch', sequence: 0, ...feedHttpTrace(result.transport) }],
        runMetrics: {
          bootstrap: result.bootstrapMetrics,
          parserRejected: result.rejections.length,
          articleTriggerEligible: articleItems.length,
          podcastTranscriptTriggerEligible: podcastItems.length,
          youtubeMetadataTriggerEligible: youtubeItems.length,
        },
        db: dependencies?.db,
      });
      return {
        runId: job.runId,
        status: persisted.state,
        receiptCount: persisted.receiptCount,
        revisionCount: persisted.revisionCount,
        outboxCount: persisted.outboxCount,
        triggeredJobCount: persisted.triggeredJobCount,
      };
    }

    if (run.request.jobKind === 'ARTICLE_FETCH') {
      if (!flags.pipelineEnabled || !flags.httpAcquisitionEnabled) {
        throw new Error('Formal article acquisition is disabled');
      }
      const result = await runArticleAdapter({
        endpointKey: run.request.endpoint.endpointKey,
        discoveryItem: run.request.discoveryItem,
        allowedOrigins: run.request.allowedOrigins,
        validator: run.request.validator,
        fetchImpl: dependencies?.fetchImpl,
        timeoutMs: flags.httpTimeoutMs,
        maximumBytes: flags.httpMaxOutputBytes,
      });
      const persisted = await persistAcquisitionResult({
        runId: job.runId,
        state: result.stateHint,
        batches: [result.batch],
        checkpointComplete: false,
        httpTraces: articleHttpTraces(result),
        runMetrics: { extraction: result.extraction },
        db: dependencies?.db,
      });
      return {
        runId: job.runId,
        status: persisted.state,
        receiptCount: persisted.receiptCount,
        revisionCount: persisted.revisionCount,
        outboxCount: persisted.outboxCount,
        triggeredJobCount: persisted.triggeredJobCount,
      };
    }

    if (run.request.jobKind === 'YOUTUBE_METADATA') {
      if (
        !flags.pipelineEnabled ||
        !flags.httpAcquisitionEnabled ||
        !flags.youtubeDiscoveryEnabled ||
        !flags.youtubeNativeEnabled
      ) {
        throw new Error('Formal YouTube metadata acquisition is disabled');
      }
      const request = run.request;
      const expectedChannelId = request.endpoint.locator.channelId;
      if (!expectedChannelId) throw new Error('YouTube endpoint has no persisted channel ID');
      const db = dependencies?.db ?? (await getDb());
      const checkedAt = await databaseNow(db);
      const client =
        dependencies?.youtubeMetadataClient ??
        new YouTubeMetadataClient({
          apiKey: process.env.YOUTUBE_DATA_API_KEY ?? '',
          timeoutMs: flags.httpTimeoutMs,
          maximumResponseBytes: flags.httpMaxOutputBytes,
        });
      const execution = await client.getVideo({
        discoveryItem: request.discoveryItem,
        expectedChannelId,
      });
      let item = execution.item;
      let state: 'COMPLETED' | 'CONTENT_DEFERRED' = 'CONTENT_DEFERRED';
      const triggeredJobs: Array<
        NonNullable<Parameters<typeof persistAcquisitionResult>[0]['triggeredJobs']>[number]
      > = [];
      let nextEligibleAt: string | null = null;
      if (item.video?.lifecycleState === 'FINISHED') {
        const completedAt = finishedAt(item);
        const durationSeconds = item.video.durationSeconds;
        if (!completedAt || durationSeconds === null) {
          nextEligibleAt = new Date(checkedAt.getTime() + 5 * 60_000).toISOString();
        } else {
          const contentAgeMinutes = Math.max(
            0,
            (checkedAt.getTime() - completedAt.getTime()) / 60_000,
          );
          if (
            durationSeconds > YOUTUBE_TRANSCRIPT_POLICY_V1.maximumDurationSeconds ||
            contentAgeMinutes > YOUTUBE_TRANSCRIPT_POLICY_V1.maximumContentAgeMinutes
          ) {
            item = {
              ...item,
              transcript: {
                status: 'DEFERRED',
                language: null,
                trackKind: null,
                providerRevision: 'youtube-caption-policy-v1',
                segments: [],
              },
            };
          } else {
            const nativeEligibleAt = new Date(completedAt.getTime() + 10 * 60_000);
            nextEligibleAt = nativeEligibleAt.toISOString();
            if (nativeEligibleAt <= checkedAt) {
              state = 'COMPLETED';
              triggeredJobs.push({
                queueName: 'content-http-acquisition',
                priority: 50,
                request: {
                  schemaVersion: 1,
                  jobKind: 'YOUTUBE_TRANSCRIPT',
                  adapterKind: 'SUPADATA_TRANSCRIPT',
                  phase: request.phase,
                  profileKey: request.profileKey,
                  profileRevision: request.profileRevision,
                  windowStart: checkedAt.toISOString(),
                  windowEnd: checkedAt.toISOString(),
                  endpoint: request.endpoint,
                  discoveryItem: item,
                  mode: 'NATIVE',
                  attemptStage: 'NATIVE_FIRST',
                  policy: YOUTUBE_TRANSCRIPT_POLICY_V1,
                },
              });
            }
          }
        }
      } else {
        const recheckMinutes =
          item.video?.lifecycleState === 'UPCOMING'
            ? request.policy.upcomingRecheckMinutes
            : request.policy.liveRecheckMinutes;
        nextEligibleAt = new Date(checkedAt.getTime() + recheckMinutes * 60_000).toISOString();
      }
      const persisted = await persistAcquisitionResult({
        runId: job.runId,
        state,
        batches: [resultBatch(item, checkedAt)],
        checkpointComplete: false,
        triggeredJobs,
        providerTraces: [
          {
            sequence: run.providerTraceSequence,
            provider: 'youtube-data-api',
            operation: 'videos.list',
            requestMetadataHash: execution.requestMetadataHash,
            responseMetadataHash: execution.responseMetadataHash,
            providerJobIdHash: null,
            providerUnits: execution.providerUnits,
            terminalState: execution.lifecycleState,
          },
        ],
        providerResult: {
          provider: 'youtube-data-api',
          providerUnits: execution.providerUnits,
        },
        runMetrics: {
          lifecycleState: execution.lifecycleState,
          durationMs: execution.durationMs,
          nextEligibleAt,
          transcriptTriggered: triggeredJobs.length === 1,
        },
        db,
      });
      return {
        runId: job.runId,
        status: persisted.state,
        receiptCount: persisted.receiptCount,
        revisionCount: persisted.revisionCount,
        outboxCount: persisted.outboxCount,
        triggeredJobCount: persisted.triggeredJobCount,
      };
    }

    if (run.request.jobKind === 'YOUTUBE_TRANSCRIPT') {
      if (!flags.pipelineEnabled || !flags.httpAcquisitionEnabled || !flags.youtubeNativeEnabled) {
        throw new Error('Formal YouTube transcript acquisition is disabled');
      }
      const request = run.request;
      const video = request.discoveryItem.video;
      if (!video || video.lifecycleState !== 'FINISHED' || video.durationSeconds === null) {
        throw new Error('Persisted YouTube transcript request has no finished video duration');
      }
      const db = dependencies?.db ?? (await getDb());
      const checkedAt = await databaseNow(db);
      if (!run.providerJobId) {
        const expectedCredits =
          request.mode === 'NATIVE' ? 1 : Math.ceil(video.durationSeconds / 60) * 2;
        const budget = await reserveSupadataCreditBudget({
          runId: job.runId,
          expectedCredits,
          dailyCreditLimit: flags.supadataDailyCreditLimit,
          db,
        });
        if (!budget.reserved) {
          await deferFormalRunForBudget({
            runId: job.runId,
            metrics: {
              provider: 'supadata',
              expectedCredits,
              remainingCredits: budget.remainingCreditsBeforeReservation,
              mode: request.mode,
              attemptStage: request.attemptStage,
            },
            db,
          });
          return {
            runId: job.runId,
            status: 'BUDGET_DEFERRED',
            receiptCount: 0,
            revisionCount: 0,
            outboxCount: 0,
            triggeredJobCount: 0,
          };
        }
      }
      const client =
        dependencies?.supadataClient ??
        new SupadataTranscriptClient({
          apiKey: process.env.SUPADATA_API_KEY ?? '',
          timeoutMs: flags.supadataTimeoutMs,
          maximumResponseBytes: flags.supadataMaxOutputBytes,
        });
      const providerResult: SupadataSubmitResult | SupadataPollResult = run.providerJobId
        ? await client.poll(run.providerJobId)
        : await client.submit({
            videoUrl: request.discoveryItem.sourceUrl ?? '',
            mode: request.mode.toLowerCase() as 'native' | 'auto',
            language: request.policy.language,
          });
      if (providerResult.kind === 'PENDING') {
        const providerJobId = 'jobId' in providerResult ? providerResult.jobId : run.providerJobId;
        if (!providerJobId) throw new Error('Supadata pending result lost its provider job ID');
        await parkFormalRunForProviderPoll({
          runId: job.runId,
          providerJobId,
          providerUnits: providerResult.providerUnits,
          nextPollAt: new Date(checkedAt.getTime() + flags.supadataJobPollIntervalMs),
          trace: {
            sequence: run.providerTraceSequence,
            operation: run.providerJobId ? 'transcript.poll' : 'transcript.submit',
            requestMetadataHash: providerResult.requestMetadataHash,
            responseMetadataHash: providerResult.responseMetadataHash,
            providerJobIdHash: providerResult.providerJobIdHash,
            terminalState:
              'providerStatus' in providerResult
                ? providerResult.providerStatus.toUpperCase()
                : 'SUBMITTED',
          },
          metrics: {
            providerState:
              'providerStatus' in providerResult
                ? providerResult.providerStatus.toUpperCase()
                : 'SUBMITTED',
            providerPollCount: run.providerTraceSequence,
            mode: request.mode,
            attemptStage: request.attemptStage,
          },
          commitReservedCredits: run.providerJobId === null,
          db,
        });
        return {
          runId: job.runId,
          status: 'PROVIDER_PENDING',
          receiptCount: 0,
          revisionCount: 0,
          outboxCount: 0,
          triggeredJobCount: 0,
        };
      }

      const providerJobIdHash =
        'providerJobIdHash' in providerResult ? providerResult.providerJobIdHash : null;
      const totalProviderUnits = run.providerUnits + providerResult.providerUnits;
      let item: AcquisitionItemV1 | null = null;
      let state: 'COMPLETED' | 'CONTENT_DEFERRED' = 'CONTENT_DEFERRED';
      const providerTerminalState: string = providerResult.kind;
      let nextEligibleAt: string | null = null;
      if (providerResult.kind === 'COMPLETED') {
        item = {
          ...request.discoveryItem,
          transcript: {
            status: 'PROVIDED',
            language: providerResult.language,
            trackKind: 'UNKNOWN',
            providerRevision: `${SUPADATA_PROVIDER_REVISION}:${request.mode.toLowerCase()}`,
            segments: [...providerResult.segments],
          },
        };
        state = 'COMPLETED';
      } else if (providerResult.kind === 'FAILED' || providerResult.kind === 'EMPTY') {
        const errorCode = providerResult.kind === 'FAILED' ? providerResult.errorCode : 'empty';
        item = {
          ...request.discoveryItem,
          transcript: {
            status: 'FAILED',
            language: providerResult.kind === 'EMPTY' ? providerResult.language : null,
            trackKind: 'UNKNOWN',
            providerRevision:
              `${SUPADATA_PROVIDER_REVISION}:${request.mode.toLowerCase()}:${errorCode}`.slice(
                0,
                200,
              ),
            segments: [],
          },
        };
      } else if (providerResult.kind === 'UNAVAILABLE') {
        const completedAt = finishedAt(request.discoveryItem) ?? checkedAt;
        const nextOffsetMinutes = request.attemptStage === 'NATIVE_FIRST' ? 45 : 60;
        nextEligibleAt = new Date(
          Math.max(
            checkedAt.getTime() + 60_000,
            completedAt.getTime() + nextOffsetMinutes * 60_000,
          ),
        ).toISOString();
        if (request.attemptStage === 'NATIVE_SECOND' && !flags.youtubeGeneratedEnabled) {
          item = {
            ...request.discoveryItem,
            transcript: {
              status: 'DEFERRED',
              language: null,
              trackKind: null,
              providerRevision: `${SUPADATA_PROVIDER_REVISION}:native:unavailable`,
              segments: [],
            },
          };
        }
      }
      const batches = item ? [resultBatch(item, checkedAt)] : [];
      const persisted = await persistAcquisitionResult({
        runId: job.runId,
        state,
        batches,
        checkpointComplete: false,
        transcriptEvidence: item
          ? {
              [transcriptEvidenceKey(item)]: {
                provider: 'supadata',
                engine: request.mode.toLowerCase(),
                modelRevision: null,
                optionsRevision: SUPADATA_PROVIDER_REVISION,
                mediaHash: null,
              },
            }
          : undefined,
        providerTraces: [
          {
            sequence: run.providerTraceSequence,
            provider: 'supadata',
            operation: run.providerJobId ? 'transcript.poll' : 'transcript.submit',
            requestMetadataHash: providerResult.requestMetadataHash,
            responseMetadataHash: providerResult.responseMetadataHash,
            providerJobIdHash,
            providerUnits: providerResult.providerUnits,
            terminalState: providerTerminalState,
          },
        ],
        providerResult: { provider: 'supadata', providerUnits: totalProviderUnits },
        runMetrics: {
          mode: request.mode,
          attemptStage: request.attemptStage,
          providerTerminalState,
          providerDurationMs: providerResult.durationMs,
          segmentCount: providerResult.kind === 'COMPLETED' ? providerResult.segments.length : 0,
          nextEligibleAt,
        },
        db,
      });
      return {
        runId: job.runId,
        status: persisted.state,
        receiptCount: persisted.receiptCount,
        revisionCount: persisted.revisionCount,
        outboxCount: persisted.outboxCount,
        triggeredJobCount: persisted.triggeredJobCount,
      };
    }

    throw new Error(`HTTP worker cannot execute ${run.request.jobKind}`);
  } catch (error) {
    if (began) {
      const failure = errorFacts(error);
      await failFormalRun({
        runId: job.runId,
        failureClass: failure.failureClass,
        errorSummary: failure.summary,
        db: dependencies?.db,
      });
    }
    throw error;
  }
}
