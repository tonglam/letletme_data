import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  contentAcquisitionRuns,
  contentAcquisitionGaps,
  contentAcquisitionHttpTraces,
  contentAcquisitionJobOutbox,
  contentAcquisitionProviderTraces,
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceObservations,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
  contentSourceTranscriptRevisions,
  contentSourceTranscriptSegments,
  contentSources,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle } from '../../db/singleton';
import {
  acquisitionBatchV1Schema,
  canonicalAcquisitionItem,
  type AcquisitionBatchV1,
  type AcquisitionItemV1,
} from './acquisition-contract';
import { sha256CanonicalJson, transcriptSegmentsHash } from './canonicalization';
import type { CanonicalTranscriptSegmentV1, JsonValue } from './canonicalization';
import {
  parseFormalRunRequestV1,
  type ArticleFetchRunRequestV1,
  type PodcastTranscriptRunRequestV1,
  type YouTubeMetadataRunRequestV1,
  type YouTubeTranscriptRunRequestV1,
  type XScanRunRequestV1,
} from './formal-run-contract';
import {
  commitRunBudgets,
  reconcileReservedProviderBudget,
  reserveXRunBudgets,
  type XBudgetPolicy,
} from './x-budget';
import type { XAcquisitionLane } from './acquisition-profiles';

export type PersistedAcquisitionState =
  | 'EMPTY'
  | 'CHECKED_NO_CHANGE'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'SATURATED'
  | 'GAP'
  | 'CONTENT_DEFERRED';

export type AcquisitionItemRejection = Readonly<{
  endpointKey: string;
  externalItemId: string;
  reasonCode: string;
  nativeItemHash?: string | null;
}>;

export type TranscriptEvidence = Readonly<{
  provider?: string | null;
  engine?: string | null;
  modelRevision?: string | null;
  optionsRevision?: string | null;
  mediaHash?: string | null;
}>;

export type TriggeredContentJob =
  | Readonly<{
      request: ArticleFetchRunRequestV1;
      queueName: 'content-http-acquisition';
      priority: number;
      availableAt?: Date;
    }>
  | Readonly<{
      request: XScanRunRequestV1;
      queueName: 'content-x-scan';
      priority: number;
      availableAt?: Date;
    }>
  | Readonly<{
      request: PodcastTranscriptRunRequestV1;
      queueName: 'content-media-transcript';
      priority: number;
      availableAt?: Date;
    }>
  | Readonly<{
      request: YouTubeMetadataRunRequestV1 | YouTubeTranscriptRunRequestV1;
      queueName: 'content-http-acquisition';
      priority: number;
      availableAt?: Date;
    }>;

export type PersistAcquisitionResultInput = Readonly<{
  runId: string;
  state: PersistedAcquisitionState;
  batches: readonly AcquisitionBatchV1[];
  rejections?: readonly AcquisitionItemRejection[];
  checkpointComplete: boolean;
  checkpoint?: Readonly<Record<string, unknown>>;
  nextDueAt?: Date | null;
  bootstrapCompleted?: boolean;
  transcriptEvidence?: Readonly<Record<string, TranscriptEvidence>>;
  endpointIdentityEvidence?: Readonly<Record<string, Readonly<{ stableExternalId: string }>>>;
  semanticAuthorEvidence?: Readonly<Record<string, Readonly<{ authorHandle: string }>>>;
  triggeredJobs?: readonly TriggeredContentJob[];
  triggeredXBudget?: Readonly<{
    policy: XBudgetPolicy;
    lane: XAcquisitionLane;
  }>;
  acquisitionGap?: Readonly<{
    windowStart: string;
    windowEnd: string;
    reason: string;
    detailsHash?: string | null;
  }>;
  httpTraces?: readonly Readonly<{
    operation: string;
    sequence: number;
    requestMetadataHash: string;
    responseMetadataHash: string | null;
    transportBodyHash: string | null;
    finalUrlHash: string | null;
    httpStatus: number | null;
    redirectCount: number;
    responseBytes: number | null;
    validatorResult: 'NONE' | 'ETAG' | 'LAST_MODIFIED' | 'BOTH' | 'NOT_MODIFIED' | null;
  }>[];
  providerTraces?: readonly Readonly<{
    sequence: number;
    provider: string;
    operation: string;
    requestMetadataHash: string;
    responseMetadataHash: string | null;
    providerJobIdHash: string | null;
    providerUnits: number | null;
    terminalState: string | null;
  }>[];
  providerResult?: Readonly<{
    provider: string;
    providerUnits: number | null;
  }>;
  runMetrics?: Readonly<Record<string, unknown>>;
  db?: DbHandle;
}>;

export type PersistAcquisitionResult = Readonly<{
  state: PersistedAcquisitionState;
  receiptCount: number;
  revisionCount: number;
  unchangedCount: number;
  rejectedCount: number;
  outboxCount: number;
  checkpointAdvanced: boolean;
  triggeredJobCount: number;
}>;

type CanonicalWorkItem = Readonly<{
  receiptKey: string;
  sourceId: string;
  primaryEndpointId: string;
  externalItemId: string;
  item: AcquisitionItemV1;
  payload: ReturnType<typeof canonicalAcquisitionItem>['payload'];
  canonicalHash: string;
  transcriptSegments: readonly CanonicalTranscriptSegmentV1[];
  rightsPolicy: Readonly<Record<string, unknown>>;
  observationEndpoints: readonly string[];
}>;

function receiptKey(input: {
  sourceKey: string;
  contentKind: AcquisitionItemV1['contentKind'];
  externalItemId: string;
}): string {
  if (input.contentKind === 'POST') return `x:${input.externalItemId}`;
  if (input.contentKind === 'VIDEO') return `youtube:${input.externalItemId}`;
  if (input.contentKind === 'EPISODE') {
    return `podcast:${input.sourceKey}:${input.externalItemId}`;
  }
  return `article:${input.sourceKey}:${input.externalItemId}`;
}

export { receiptKey as acquisitionReceiptKey };

function assertResultSemantics(input: PersistAcquisitionResultInput): void {
  const itemCount = input.batches.reduce((total, batch) => total + batch.items.length, 0);
  const rejectedCount = input.rejections?.length ?? 0;
  if (input.state === 'EMPTY' && (itemCount !== 0 || rejectedCount !== 0)) {
    throw new Error('EMPTY requires a successful zero-item result');
  }
  if (input.state === 'PARTIAL' && (itemCount === 0 || rejectedCount === 0)) {
    throw new Error('PARTIAL requires accepted and rejected items');
  }
  if (input.state === 'COMPLETED' && itemCount === 0) {
    throw new Error('COMPLETED requires at least one valid item');
  }
  if (input.state === 'SATURATED' && itemCount === 0) {
    throw new Error('SATURATED requires returned items');
  }
  if (
    input.checkpointComplete &&
    !['EMPTY', 'CHECKED_NO_CHANGE', 'COMPLETED', 'SATURATED', 'PARTIAL'].includes(input.state)
  ) {
    throw new Error(`${input.state} cannot advance a discovery checkpoint`);
  }
}

function transcriptEvidenceKey(endpointKey: string, externalItemId: string): string {
  return `${endpointKey}\u0000${externalItemId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rightsPolicyHash(value: unknown): string {
  return sha256CanonicalJson(asRecord(value) as Record<string, JsonValue>);
}

class StaleTargetReceiptRevisionError extends Error {
  readonly failureClass = 'STALE_TARGET_RECEIPT_REVISION';

  constructor() {
    super('STALE_TARGET_RECEIPT_REVISION');
    this.name = 'StaleTargetReceiptRevisionError';
  }
}

export async function persistAcquisitionResult(
  input: PersistAcquisitionResultInput,
): Promise<PersistAcquisitionResult> {
  assertResultSemantics(input);
  const batches = input.batches.map((batch) => acquisitionBatchV1Schema.parse(batch));
  const db = input.db ?? (await getDb());

  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = new Date(clockRows[0]?.dbNow ?? Date.now());
    if (!Number.isFinite(dbNow.getTime())) throw new Error('Database clock is invalid');

    const runRows = await tx
      .select({
        runId: contentAcquisitionRuns.runId,
        status: contentAcquisitionRuns.status,
        endpointId: contentAcquisitionRuns.endpointId,
        partitionId: contentAcquisitionRuns.sourcePartitionId,
        scheduleId: contentAcquisitionRuns.scheduleId,
        parentRunId: contentAcquisitionRuns.parentRunId,
        adapterKind: contentAcquisitionRuns.adapterKind,
        jobKind: contentAcquisitionRuns.jobKind,
        profileKey: contentAcquisitionRuns.profileKey,
        profileRevision: contentAcquisitionRuns.profileRevision,
        windowStart: contentAcquisitionRuns.windowStart,
        windowEnd: contentAcquisitionRuns.windowEnd,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
        sourceSnapshot: contentAcquisitionRuns.sourceSnapshot,
        endpointSnapshot: contentAcquisitionRuns.endpointSnapshot,
        targetReceiptId: contentAcquisitionRuns.targetReceiptId,
        targetReceiptRevisionId: contentAcquisitionRuns.targetReceiptRevisionId,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = runRows[0];
    if (!run) throw new Error(`Acquisition run not found: ${input.runId}`);
    if (run.status !== 'RUNNING') throw new Error(`Acquisition run is not RUNNING: ${run.status}`);
    const request = parseFormalRunRequestV1(run.requestSnapshot);
    if (
      request.jobKind !== run.jobKind ||
      request.adapterKind !== run.adapterKind ||
      request.profileKey !== run.profileKey ||
      request.profileRevision !== run.profileRevision
    ) {
      throw new Error('Acquisition run columns do not match its immutable request snapshot');
    }
    if ((run.targetReceiptId === null) !== (run.targetReceiptRevisionId === null)) {
      throw new Error('Triggered acquisition run has an incomplete target receipt contract');
    }
    let targetReceiptKey: string | null = null;
    if (run.targetReceiptId && run.targetReceiptRevisionId) {
      const targetSnapshot = await tx
        .select({ receiptKey: contentSourceReceipts.receiptKey })
        .from(contentSourceReceipts)
        .where(eq(contentSourceReceipts.receiptId, run.targetReceiptId))
        .limit(1);
      targetReceiptKey = targetSnapshot[0]?.receiptKey ?? null;
      if (!targetReceiptKey) throw new Error('Triggered acquisition target receipt disappeared');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${targetReceiptKey}))`);
      const currentTarget = await tx
        .select({
          currentRevisionId: contentSourceReceipts.currentRevisionId,
          sourceId: contentSourceReceipts.sourceId,
          primaryEndpointId: contentSourceReceipts.primaryEndpointId,
          externalId: contentSourceReceipts.externalId,
          contentKind: contentSourceReceipts.contentKind,
        })
        .from(contentSourceReceipts)
        .where(eq(contentSourceReceipts.receiptId, run.targetReceiptId))
        .for('update')
        .limit(1);
      if (currentTarget[0]?.currentRevisionId !== run.targetReceiptRevisionId) {
        throw new StaleTargetReceiptRevisionError();
      }
      const target = currentTarget[0];
      if (
        !target ||
        !('endpoint' in request) ||
        !('discoveryItem' in request) ||
        target.sourceId !== request.endpoint.sourceId ||
        target.primaryEndpointId !== request.endpoint.endpointId ||
        target.externalId !== request.discoveryItem.externalItemId ||
        target.contentKind !== request.discoveryItem.contentKind
      ) {
        throw new Error('Triggered acquisition request does not match its target receipt identity');
      }
    }
    const immutableEndpoints =
      'endpoint' in request ? [request.endpoint] : request.partition.members;
    const immutableEndpointByKey = new Map(
      immutableEndpoints.map((endpoint) => [endpoint.endpointKey, endpoint]),
    );

    const requestedEndpointKeys = [
      ...new Set([
        ...batches.map((batch) => batch.endpointKey),
        ...(input.rejections ?? []).map((rejection) => rejection.endpointKey),
      ]),
    ].sort();
    const endpointRows =
      requestedEndpointKeys.length === 0
        ? []
        : await tx
            .select({
              endpointId: contentSourceEndpoints.endpointId,
              endpointKey: contentSourceEndpoints.endpointKey,
              sourceId: contentSourceEndpoints.sourceId,
              sourceKey: contentSources.sourceKey,
              rightsPolicy: contentSourceEndpoints.rightsPolicy,
              stableExternalId: contentSourceEndpoints.stableExternalId,
              adapterKind: contentSourceEndpoints.adapterKind,
              locator: contentSourceEndpoints.locator,
              endpointStatus: contentSourceEndpoints.status,
              endpointOrigin: contentSourceEndpoints.origin,
            })
            .from(contentSourceEndpoints)
            .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
            .where(inArray(contentSourceEndpoints.endpointKey, requestedEndpointKeys))
            .orderBy(asc(contentSourceEndpoints.endpointKey));
    const endpointByKey = new Map(endpointRows.map((endpoint) => [endpoint.endpointKey, endpoint]));
    if (endpointRows.length !== requestedEndpointKeys.length) {
      throw new Error('Acquisition result references an unknown endpoint');
    }

    for (const [endpointKey, evidence] of Object.entries(input.endpointIdentityEvidence ?? {})) {
      const endpoint = endpointByKey.get(endpointKey);
      if (!endpoint)
        throw new Error(`Identity evidence references unknown endpoint ${endpointKey}`);
      if (
        endpoint.stableExternalId !== null &&
        endpoint.stableExternalId !== evidence.stableExternalId
      ) {
        throw new Error(`Stable endpoint identity conflict: ${endpointKey}`);
      }
      await tx
        .update(contentSourceEndpoints)
        .set({
          stableExternalId: evidence.stableExternalId,
          identityStatus: 'VERIFIED',
          identityErrorSummary: null,
          identityCheckedAt: dbNow,
          identityNextCheckAt: new Date(dbNow.getTime() + 30 * 24 * 60 * 60_000),
          updatedAt: dbNow,
        })
        .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
    }

    if (run.endpointId) {
      const immutableEndpoint = immutableEndpoints[0];
      if (
        immutableEndpoints.length !== 1 ||
        !immutableEndpoint ||
        immutableEndpoint.endpointId !== run.endpointId ||
        endpointRows.some(
          (endpoint) =>
            endpoint.endpointId !== immutableEndpoint.endpointId ||
            endpoint.endpointKey !== immutableEndpoint.endpointKey ||
            endpoint.sourceId !== immutableEndpoint.sourceId ||
            endpoint.sourceKey !== immutableEndpoint.sourceKey,
        )
      ) {
        throw new Error('Endpoint result does not match its immutable request snapshot');
      }
    } else if (run.partitionId && input.semanticAuthorEvidence) {
      if (run.adapterKind !== 'X_SEMANTIC') {
        throw new Error('Semantic author evidence is only valid for X_SEMANTIC runs');
      }
      if (!('partition' in request) || request.partition.partitionId !== run.partitionId) {
        throw new Error('Semantic partition run does not match its immutable request snapshot');
      }
      const returnedEndpointKeys = [...new Set(batches.map((batch) => batch.endpointKey))].sort();
      const evidenceKeys = Object.keys(input.semanticAuthorEvidence).sort();
      if (sha256CanonicalJson(evidenceKeys) !== sha256CanonicalJson(returnedEndpointKeys)) {
        throw new Error('Semantic author evidence must cover exactly the accepted endpoints');
      }
      const immutableSemanticKeys = new Set(
        request.partition.members.map((member) => member.endpointKey),
      );
      for (const rejection of input.rejections ?? []) {
        if (
          !input.semanticAuthorEvidence[rejection.endpointKey] &&
          !immutableSemanticKeys.has(rejection.endpointKey)
        ) {
          throw new Error(
            'Semantic rejection escaped resolved authors and its immutable partition',
          );
        }
      }
      for (const endpointKey of evidenceKeys) {
        const endpoint = endpointByKey.get(endpointKey);
        if (!endpoint)
          throw new Error(`Semantic evidence references unknown endpoint ${endpointKey}`);
        const evidence = input.semanticAuthorEvidence[endpoint.endpointKey];
        const locator =
          endpoint.locator &&
          typeof endpoint.locator === 'object' &&
          !Array.isArray(endpoint.locator)
            ? (endpoint.locator as Record<string, unknown>)
            : null;
        const handle = typeof locator?.handle === 'string' ? locator.handle : null;
        if (
          !evidence ||
          endpoint.adapterKind !== 'X_ACCOUNT' ||
          !['active', 'paused', 'observed'].includes(endpoint.endpointStatus) ||
          !handle ||
          handle.toLowerCase() !== evidence.authorHandle.toLowerCase()
        ) {
          throw new Error('Semantic result is not bound to its resolved X author endpoint');
        }
      }
      for (const endpoint of endpointRows) {
        if (!immutableSemanticKeys.has(endpoint.endpointKey)) continue;
        const immutableEndpoint = immutableEndpointByKey.get(endpoint.endpointKey);
        if (
          !immutableEndpoint ||
          endpoint.endpointId !== immutableEndpoint.endpointId ||
          endpoint.sourceId !== immutableEndpoint.sourceId ||
          endpoint.sourceKey !== immutableEndpoint.sourceKey ||
          endpoint.adapterKind !== 'X_SEMANTIC'
        ) {
          throw new Error('Semantic rejection endpoint escaped its immutable partition snapshot');
        }
      }
    } else if (run.partitionId) {
      if (!('partition' in request) || request.partition.partitionId !== run.partitionId) {
        throw new Error('Partition run does not match its immutable request snapshot');
      }
      if (
        endpointRows.some((endpoint) => {
          const immutableEndpoint = immutableEndpointByKey.get(endpoint.endpointKey);
          return (
            !immutableEndpoint ||
            endpoint.endpointId !== immutableEndpoint.endpointId ||
            endpoint.sourceId !== immutableEndpoint.sourceId ||
            endpoint.sourceKey !== immutableEndpoint.sourceKey
          );
        })
      ) {
        throw new Error('Partition result escaped its immutable request snapshot');
      }
    } else {
      throw new Error('Formal acquisition run has no endpoint or partition target');
    }

    const workByReceiptKey = new Map<string, CanonicalWorkItem>();
    for (const batch of batches) {
      const endpoint = endpointByKey.get(batch.endpointKey);
      if (!endpoint) throw new Error(`Missing endpoint ${batch.endpointKey}`);
      for (const item of batch.items) {
        const canonical = canonicalAcquisitionItem(item);
        const key = receiptKey({
          sourceKey: endpoint.sourceKey,
          contentKind: item.contentKind,
          externalItemId: item.externalItemId,
        });
        const prior = workByReceiptKey.get(key);
        if (prior) {
          if (
            prior.canonicalHash !== canonical.hash ||
            prior.sourceId !== endpoint.sourceId ||
            prior.item.contentKind !== item.contentKind
          ) {
            throw new Error(`Conflicting cross-endpoint facts for receipt ${key}`);
          }
          workByReceiptKey.set(key, {
            ...prior,
            observationEndpoints: [
              ...new Set([...prior.observationEndpoints, endpoint.endpointId]),
            ].sort(),
          });
          continue;
        }
        workByReceiptKey.set(key, {
          receiptKey: key,
          sourceId: endpoint.sourceId,
          primaryEndpointId: endpoint.endpointId,
          externalItemId: item.externalItemId,
          item,
          payload: canonical.payload,
          canonicalHash: canonical.hash,
          transcriptSegments: canonical.segments,
          rightsPolicy:
            run.adapterKind === 'X_SEMANTIC'
              ? asRecord(endpoint.rightsPolicy)
              : asRecord(
                  asRecord(immutableEndpointByKey.get(batch.endpointKey)?.rightsPolicy).endpoint,
                ),
          observationEndpoints: [endpoint.endpointId],
        });
      }
    }

    const workItems = [...workByReceiptKey.values()].sort((left, right) =>
      left.receiptKey.localeCompare(right.receiptKey),
    );
    if (
      targetReceiptKey &&
      (workItems.length > 1 || (workItems[0] && workItems[0].receiptKey !== targetReceiptKey))
    ) {
      throw new Error('Triggered acquisition result escaped its target receipt identity');
    }
    for (const item of workItems) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${item.receiptKey}))`);
    }
    const existingReceipts =
      workItems.length === 0
        ? []
        : await tx
            .select({
              receiptId: contentSourceReceipts.receiptId,
              receiptKey: contentSourceReceipts.receiptKey,
              sourceId: contentSourceReceipts.sourceId,
              externalId: contentSourceReceipts.externalId,
              contentKind: contentSourceReceipts.contentKind,
              currentRevisionId: contentSourceReceipts.currentRevisionId,
              rightsPolicy: contentSourceReceipts.rightsPolicy,
            })
            .from(contentSourceReceipts)
            .where(
              inArray(
                contentSourceReceipts.receiptKey,
                workItems.map((item) => item.receiptKey),
              ),
            )
            .orderBy(asc(contentSourceReceipts.receiptKey))
            .for('update');
    const existingByKey = new Map(existingReceipts.map((receipt) => [receipt.receiptKey, receipt]));
    const currentRevisionIds = existingReceipts.flatMap((receipt) =>
      receipt.currentRevisionId ? [receipt.currentRevisionId] : [],
    );
    const currentRevisions =
      currentRevisionIds.length === 0
        ? []
        : await tx
            .select({
              receiptRevisionId: contentSourceReceiptRevisions.receiptRevisionId,
              revisionNumber: contentSourceReceiptRevisions.revisionNumber,
              canonicalHash: contentSourceReceiptRevisions.canonicalHash,
            })
            .from(contentSourceReceiptRevisions)
            .where(inArray(contentSourceReceiptRevisions.receiptRevisionId, currentRevisionIds));
    const revisionById = new Map(
      currentRevisions.map((revision) => [revision.receiptRevisionId, revision]),
    );

    let revisionCount = 0;
    let unchangedCount = 0;
    let outboxCount = 0;
    const revisedReceiptKeys = new Set<string>();
    const persistedReceiptByKey = new Map<
      string,
      Readonly<{ receiptId: string; receiptRevisionId: string }>
    >();
    const observationRows: Array<{
      observationId: string;
      runId: string;
      endpointId: string;
      externalItemId: string;
      receiptId: string | null;
      receiptRevisionId: string | null;
      outcome: string;
      nativeItemHash: string | null;
      reasonCode: string | null;
      observedAt: Date;
    }> = [];

    for (const work of workItems) {
      const existing = existingByKey.get(work.receiptKey);
      if (
        existing &&
        (existing.sourceId !== work.sourceId ||
          existing.externalId !== work.externalItemId ||
          existing.contentKind !== work.item.contentKind)
      ) {
        throw new Error(`Stable receipt identity conflict: ${work.receiptKey}`);
      }
      const current = existing?.currentRevisionId
        ? revisionById.get(existing.currentRevisionId)
        : undefined;
      if (existing && !current) {
        throw new Error(`Receipt ${work.receiptKey} has no readable current revision`);
      }

      const receiptId = existing?.receiptId ?? randomUUID();
      let receiptRevisionId = current?.receiptRevisionId ?? null;
      let outcome: 'ACCEPTED' | 'UNCHANGED' = 'UNCHANGED';

      if (!existing || current?.canonicalHash !== work.canonicalHash) {
        const revisionNumber = (current?.revisionNumber ?? 0) + 1;
        receiptRevisionId = randomUUID();
        outcome = 'ACCEPTED';
        if (!existing) {
          await tx.insert(contentSourceReceipts).values({
            receiptId,
            receiptKey: work.receiptKey,
            runId: input.runId,
            sourceId: work.sourceId,
            primaryEndpointId: work.primaryEndpointId,
            externalId: work.externalItemId,
            contentKind: work.item.contentKind,
            canonicalUrl: work.item.canonicalUrl,
            currentRevisionId: null,
            capturedAt: dbNow,
            publishedAt: work.item.publishedAt ? new Date(work.item.publishedAt) : null,
            payload: work.payload,
            canonicalHash: work.canonicalHash,
            rightsPolicy: work.rightsPolicy,
          });
        }
        await tx.insert(contentSourceReceiptRevisions).values({
          receiptRevisionId,
          receiptId,
          revisionNumber,
          runId: input.runId,
          endpointId: work.primaryEndpointId,
          payload: work.payload,
          canonicalHash: work.canonicalHash,
          bodyAvailability: work.item.body.availability,
        });

        const transcript = work.item.transcript;
        if (transcript.status !== 'NOT_APPLICABLE' && transcript.status !== 'PENDING') {
          const evidence =
            input.transcriptEvidence?.[
              transcriptEvidenceKey(work.item.endpointKey, work.externalItemId)
            ];
          const transcriptRevisionId = randomUUID();
          const segmentsHash =
            work.transcriptSegments.length > 0
              ? transcriptSegmentsHash(work.transcriptSegments)
              : null;
          await tx.insert(contentSourceTranscriptRevisions).values({
            transcriptRevisionId,
            receiptRevisionId,
            transcriptRevisionNumber: 1,
            status: transcript.status,
            provider: evidence?.provider ?? null,
            engine: evidence?.engine ?? null,
            modelRevision: evidence?.modelRevision ?? null,
            optionsRevision: evidence?.optionsRevision ?? null,
            language: transcript.language,
            trackKind: transcript.trackKind,
            mediaHash: evidence?.mediaHash ?? null,
            segmentsHash,
          });
          if (work.transcriptSegments.length > 0) {
            await tx.insert(contentSourceTranscriptSegments).values(
              work.transcriptSegments.map((segment, ordinal) => ({
                transcriptRevisionId,
                ordinal,
                startMs: segment.startMs,
                endMs: segment.endMs,
                normalizedText: segment.text,
                segmentHash: sha256CanonicalJson({
                  receiptKey: work.receiptKey,
                  mediaHash: evidence?.mediaHash ?? null,
                  providerRevision: transcript.providerRevision,
                  engine: evidence?.engine ?? null,
                  modelRevision: evidence?.modelRevision ?? null,
                  optionsRevision: evidence?.optionsRevision ?? null,
                  startMs: segment.startMs,
                  endMs: segment.endMs,
                  text: segment.text,
                }),
              })),
            );
          }
        }

        await tx
          .update(contentSourceReceipts)
          .set({
            canonicalUrl: work.item.canonicalUrl,
            publishedAt: work.item.publishedAt ? new Date(work.item.publishedAt) : null,
            payload: work.payload,
            canonicalHash: work.canonicalHash,
            rightsPolicy: work.rightsPolicy,
            currentRevisionId: receiptRevisionId,
          })
          .where(eq(contentSourceReceipts.receiptId, receiptId));

        const eventType = existing ? 'receipt.updated.v1' : 'receipt.accepted.v1';
        const eventKey = `${eventType}:${receiptRevisionId}`;
        const occurredAt = dbNow.toISOString();
        await tx.insert(contentPipelineOutbox).values({
          outboxId: randomUUID(),
          eventKey,
          eventType,
          receiptId,
          receiptRevisionId,
          runId: input.runId,
          sourceId: work.sourceId,
          endpointId: work.primaryEndpointId,
          occurredAt: dbNow,
          payload: {
            receiptId,
            receiptRevisionId,
            runId: input.runId,
            sourceId: work.sourceId,
            endpointId: work.primaryEndpointId,
            occurredAt,
          },
        });
        revisionCount += 1;
        outboxCount += 1;
        revisedReceiptKeys.add(work.receiptKey);
      } else {
        if (
          existing &&
          rightsPolicyHash(existing.rightsPolicy) !== rightsPolicyHash(work.rightsPolicy)
        ) {
          await tx
            .update(contentSourceReceipts)
            .set({ rightsPolicy: work.rightsPolicy })
            .where(eq(contentSourceReceipts.receiptId, existing.receiptId));
        }
        unchangedCount += 1;
      }
      if (!receiptRevisionId) {
        throw new Error(`Receipt ${work.receiptKey} has no current revision after persistence`);
      }
      persistedReceiptByKey.set(work.receiptKey, { receiptId, receiptRevisionId });

      for (const observationEndpointId of work.observationEndpoints) {
        observationRows.push({
          observationId: randomUUID(),
          runId: input.runId,
          endpointId: observationEndpointId,
          externalItemId: work.externalItemId,
          receiptId,
          receiptRevisionId,
          outcome,
          nativeItemHash: work.canonicalHash,
          reasonCode: null,
          observedAt: dbNow,
        });
      }
    }

    for (const rejection of input.rejections ?? []) {
      const endpoint = endpointByKey.get(rejection.endpointKey);
      if (!endpoint) throw new Error(`Unknown rejection endpoint ${rejection.endpointKey}`);
      observationRows.push({
        observationId: randomUUID(),
        runId: input.runId,
        endpointId: endpoint.endpointId,
        externalItemId: rejection.externalItemId,
        receiptId: null,
        receiptRevisionId: null,
        outcome: 'REJECTED',
        nativeItemHash: rejection.nativeItemHash ?? null,
        reasonCode: rejection.reasonCode,
        observedAt: dbNow,
      });
    }
    if (observationRows.length > 0) {
      await tx.insert(contentSourceObservations).values(observationRows);
    }

    if (input.httpTraces?.length) {
      const sequences = input.httpTraces.map((trace) => trace.sequence);
      if (new Set(sequences).size !== sequences.length || sequences.some((value) => value < 0)) {
        throw new Error('HTTP trace sequences must be unique non-negative integers');
      }
      await tx.insert(contentAcquisitionHttpTraces).values(
        input.httpTraces.map((trace) => ({
          traceId: randomUUID(),
          runId: input.runId,
          ...trace,
        })),
      );
    }

    if (input.providerTraces?.length) {
      const sequences = input.providerTraces.map((trace) => trace.sequence);
      if (new Set(sequences).size !== sequences.length || sequences.some((value) => value < 0)) {
        throw new Error('Provider trace sequences must be unique non-negative integers');
      }
      await tx.insert(contentAcquisitionProviderTraces).values(
        input.providerTraces.map((trace) => ({
          traceId: randomUUID(),
          runId: input.runId,
          ...trace,
          providerUnits: trace.providerUnits === null ? null : String(trace.providerUnits),
        })),
      );
    }

    let triggeredJobCount = 0;
    for (const triggered of input.triggeredJobs ?? []) {
      if (
        !Number.isSafeInteger(triggered.priority) ||
        triggered.priority < 1 ||
        triggered.priority > 1000
      ) {
        throw new Error('Triggered acquisition priority must be an integer from 1 to 1000');
      }
      const request = parseFormalRunRequestV1(triggered.request);
      let childTarget: {
        endpointId?: string;
        sourcePartitionId?: string;
        sourceSnapshot: unknown;
        endpointSnapshot: unknown;
        targetReceiptId?: string;
        targetReceiptRevisionId?: string;
        evidenceMode:
          | 'HTTP_DETERMINISTIC'
          | 'GROK_ATTESTED_FINAL'
          | 'HERMES_TIMESTAMPED'
          | 'PROVIDER_ATTESTED';
      };
      if (request.jobKind === 'ARTICLE_FETCH') {
        if (triggered.queueName !== 'content-http-acquisition') {
          throw new Error('Triggered article must target the formal HTTP queue');
        }
        const endpoint = endpointByKey.get(request.endpoint.endpointKey);
        if (!endpoint || endpoint.endpointId !== request.endpoint.endpointId) {
          throw new Error('Triggered article endpoint does not match persisted acquisition facts');
        }
        if (run.endpointId && endpoint.endpointId !== run.endpointId) {
          throw new Error('Triggered article cannot escape its parent endpoint');
        }
        const key = receiptKey({
          sourceKey: endpoint.sourceKey,
          contentKind: request.discoveryItem.contentKind,
          externalItemId: request.discoveryItem.externalItemId,
        });
        const work = workByReceiptKey.get(key);
        if (!work || work.canonicalHash !== canonicalAcquisitionItem(request.discoveryItem).hash) {
          throw new Error('Triggered article request is not bound to an accepted parent item');
        }
        if (!revisedReceiptKeys.has(key)) continue;
        const target = persistedReceiptByKey.get(key);
        if (!target) throw new Error('Triggered article target ReceiptRevision is missing');
        childTarget = {
          endpointId: endpoint.endpointId,
          sourceSnapshot: [{ sourceId: endpoint.sourceId, sourceKey: endpoint.sourceKey }],
          endpointSnapshot: request.endpoint,
          targetReceiptId: target.receiptId,
          targetReceiptRevisionId: target.receiptRevisionId,
          evidenceMode: 'HTTP_DETERMINISTIC',
        };
      } else if (request.jobKind === 'PODCAST_TRANSCRIPT') {
        if (triggered.queueName !== 'content-media-transcript') {
          throw new Error('Triggered Podcast transcript must target the media queue');
        }
        const endpoint = endpointByKey.get(request.endpoint.endpointKey);
        if (!endpoint || endpoint.endpointId !== request.endpoint.endpointId) {
          throw new Error('Triggered Podcast endpoint does not match persisted acquisition facts');
        }
        if (!run.endpointId || endpoint.endpointId !== run.endpointId) {
          throw new Error('Triggered Podcast transcript cannot escape its parent feed endpoint');
        }
        const key = receiptKey({
          sourceKey: endpoint.sourceKey,
          contentKind: request.discoveryItem.contentKind,
          externalItemId: request.discoveryItem.externalItemId,
        });
        const work = workByReceiptKey.get(key);
        if (!work || work.canonicalHash !== canonicalAcquisitionItem(request.discoveryItem).hash) {
          throw new Error('Triggered Podcast request is not bound to an accepted parent episode');
        }
        if (!revisedReceiptKeys.has(key)) continue;
        const target = persistedReceiptByKey.get(key);
        if (!target) throw new Error('Triggered Podcast target ReceiptRevision is missing');
        childTarget = {
          endpointId: endpoint.endpointId,
          sourceSnapshot: [{ sourceId: endpoint.sourceId, sourceKey: endpoint.sourceKey }],
          endpointSnapshot: request.endpoint,
          targetReceiptId: target.receiptId,
          targetReceiptRevisionId: target.receiptRevisionId,
          evidenceMode: 'HERMES_TIMESTAMPED',
        };
      } else if (
        request.jobKind === 'YOUTUBE_METADATA' ||
        request.jobKind === 'YOUTUBE_TRANSCRIPT'
      ) {
        if (triggered.queueName !== 'content-http-acquisition') {
          throw new Error('Triggered YouTube work must target the formal HTTP queue');
        }
        const endpoint = endpointByKey.get(request.endpoint.endpointKey);
        if (!endpoint || endpoint.endpointId !== request.endpoint.endpointId) {
          throw new Error('Triggered YouTube endpoint does not match persisted acquisition facts');
        }
        if (!run.endpointId || endpoint.endpointId !== run.endpointId) {
          throw new Error('Triggered YouTube work cannot escape its parent channel endpoint');
        }
        const key = receiptKey({
          sourceKey: endpoint.sourceKey,
          contentKind: request.discoveryItem.contentKind,
          externalItemId: request.discoveryItem.externalItemId,
        });
        const work = workByReceiptKey.get(key);
        if (!work || work.canonicalHash !== canonicalAcquisitionItem(request.discoveryItem).hash) {
          throw new Error('Triggered YouTube request is not bound to an accepted parent video');
        }
        if (!revisedReceiptKeys.has(key)) continue;
        const target = persistedReceiptByKey.get(key);
        if (!target) throw new Error('Triggered YouTube target ReceiptRevision is missing');
        childTarget = {
          endpointId: endpoint.endpointId,
          sourceSnapshot: [{ sourceId: endpoint.sourceId, sourceKey: endpoint.sourceKey }],
          endpointSnapshot: request.endpoint,
          targetReceiptId: target.receiptId,
          targetReceiptRevisionId: target.receiptRevisionId,
          evidenceMode: 'PROVIDER_ATTESTED',
        };
      } else if (request.jobKind === 'X_KEYWORD_SCAN' || request.jobKind === 'X_SEMANTIC_SCAN') {
        if (triggered.queueName !== 'content-x-scan') {
          throw new Error('Triggered X follow-up must target the formal X queue');
        }
        if (!run.partitionId || run.parentRunId) {
          throw new Error('Only a recurring partition run may create one X saturation follow-up');
        }
        if (
          request.partition.partitionId !== run.partitionId ||
          request.adapterKind !== run.adapterKind ||
          request.profileKey !== run.profileKey ||
          request.profileRevision !== run.profileRevision ||
          sha256CanonicalJson(request.partition) !==
            sha256CanonicalJson(run.endpointSnapshot as never)
        ) {
          throw new Error('Triggered X follow-up does not match its parent partition snapshot');
        }
        const childStart = Date.parse(request.windowStart);
        const childEnd = Date.parse(request.windowEnd);
        if (
          !run.windowStart ||
          !run.windowEnd ||
          childStart < run.windowStart.getTime() ||
          childEnd >= run.windowEnd.getTime() ||
          childEnd < childStart
        ) {
          throw new Error('Triggered X follow-up window is not a bounded earlier subwindow');
        }
        if (!input.triggeredXBudget) {
          throw new Error('Triggered X follow-up requires an explicit budget policy');
        }
        childTarget = {
          sourcePartitionId: run.partitionId,
          sourceSnapshot: run.sourceSnapshot,
          endpointSnapshot: request.partition,
          evidenceMode: 'GROK_ATTESTED_FINAL',
        };
      } else {
        throw new Error(`Unsupported triggered acquisition job ${request.jobKind}`);
      }

      const requestHash = sha256CanonicalJson(request);
      const existingChildren = await tx
        .select({ runId: contentAcquisitionRuns.runId })
        .from(contentAcquisitionRuns)
        .where(
          and(
            eq(contentAcquisitionRuns.jobKind, request.jobKind),
            eq(contentAcquisitionRuns.requestHash, requestHash),
            eq(contentAcquisitionRuns.attemptNo, 1),
          ),
        )
        .limit(1);
      if (existingChildren.length > 0) continue;

      const childRunId = randomUUID();
      const childJobId = `content-trigger-${sha256CanonicalJson({
        parentRunId: input.runId,
        requestHash,
      })}`;
      await tx.insert(contentAcquisitionRuns).values({
        runId: childRunId,
        endpointId: childTarget.endpointId,
        sourcePartitionId: childTarget.sourcePartitionId,
        parentRunId: input.runId,
        targetReceiptId: childTarget.targetReceiptId,
        targetReceiptRevisionId: childTarget.targetReceiptRevisionId,
        jobKind: request.jobKind,
        adapterKind: request.adapterKind,
        profileKey: request.profileKey,
        profileRevision: request.profileRevision,
        windowStart: new Date(request.windowStart),
        windowEnd: new Date(request.windowEnd),
        idempotencyKey: `briefing-trigger:${requestHash}:1`,
        status: 'PENDING',
        requestSnapshot: request,
        requestHash,
        sourceSnapshot: childTarget.sourceSnapshot,
        endpointSnapshot: childTarget.endpointSnapshot,
        attemptNo: 1,
        leaseExpiresAt:
          request.jobKind === 'X_KEYWORD_SCAN' || request.jobKind === 'X_SEMANTIC_SCAN'
            ? new Date(dbNow.getTime() + 6 * 60_000)
            : undefined,
        evidenceMode: childTarget.evidenceMode,
      });
      if (request.jobKind === 'X_KEYWORD_SCAN' || request.jobKind === 'X_SEMANTIC_SCAN') {
        const budget = await reserveXRunBudgets({
          tx,
          runId: childRunId,
          phase: request.phase,
          lane: input.triggeredXBudget!.lane,
          dbNow,
          policy: input.triggeredXBudget!.policy,
        });
        if (!budget.reserved) {
          await tx
            .update(contentAcquisitionRuns)
            .set({
              status: 'BUDGET_DEFERRED',
              completedAt: dbNow,
              leaseExpiresAt: null,
              checkpointAdvanced: false,
              runMetrics: {
                deferredScope: budget.deferredScope,
                remainingBeforeReservation: budget.remainingBeforeReservation,
              },
            })
            .where(eq(contentAcquisitionRuns.runId, childRunId));
          await tx.insert(contentAcquisitionGaps).values({
            gapId: randomUUID(),
            declaringRunId: childRunId,
            partitionId: run.partitionId,
            windowStart: new Date(request.windowStart),
            windowEnd: new Date(request.windowEnd),
            reason: 'SATURATION_FOLLOWUP_BUDGET_DEFERRED',
            detailsHash: sha256CanonicalJson({ deferredScope: budget.deferredScope }),
          });
          continue;
        }
      }
      await tx.insert(contentAcquisitionJobOutbox).values({
        outboxId: randomUUID(),
        runId: childRunId,
        queueName: triggered.queueName,
        jobId: childJobId,
        priority: triggered.priority,
        availableAt: triggered.availableAt ?? dbNow,
      });
      triggeredJobCount += 1;
    }

    if (input.acquisitionGap) {
      if (input.state !== 'GAP' && input.state !== 'PARTIAL' && input.state !== 'SATURATED') {
        throw new Error('Acquisition gap requires terminal PARTIAL, GAP, or SATURATED state');
      }
      const gapStart = new Date(input.acquisitionGap.windowStart);
      const gapEnd = new Date(input.acquisitionGap.windowEnd);
      if (
        !Number.isFinite(gapStart.getTime()) ||
        !Number.isFinite(gapEnd.getTime()) ||
        gapEnd < gapStart
      ) {
        throw new Error('Acquisition gap window is invalid');
      }
      if (
        input.acquisitionGap.detailsHash &&
        !/^[0-9a-f]{64}$/.test(input.acquisitionGap.detailsHash)
      ) {
        throw new Error('Acquisition gap details hash is invalid');
      }
      await tx.insert(contentAcquisitionGaps).values({
        gapId: randomUUID(),
        declaringRunId: input.runId,
        endpointId: run.endpointId,
        partitionId: run.partitionId,
        windowStart: gapStart,
        windowEnd: gapEnd,
        reason: input.acquisitionGap.reason,
        detailsHash: input.acquisitionGap.detailsHash ?? null,
      });
    }

    const derivedState =
      input.state === 'COMPLETED' && revisionCount === 0 ? 'CHECKED_NO_CHANGE' : input.state;
    if (input.state === 'CHECKED_NO_CHANGE' && revisionCount > 0) {
      throw new Error('CHECKED_NO_CHANGE cannot create a ReceiptRevision');
    }
    if (input.state === 'EMPTY' && revisionCount > 0) {
      throw new Error('EMPTY cannot create a ReceiptRevision');
    }
    if (
      input.providerResult?.provider === 'supadata' &&
      input.providerResult.providerUnits !== null
    ) {
      await reconcileReservedProviderBudget({
        tx,
        runId: input.runId,
        scopeKey: 'SUPADATA_TRANSCRIPT',
        unitKind: 'CREDIT',
        actualUnits: input.providerResult.providerUnits,
        dbNow,
      });
    }
    const committedReservations = await commitRunBudgets({ tx, runId: input.runId, dbNow });
    if (input.providerResult?.provider === 'grok-build' && committedReservations === 0) {
      throw new Error('Attested formal X result has no reserved budget');
    }

    let checkpointAdvanced = false;
    if (run.scheduleId) {
      if (!input.nextDueAt || input.nextDueAt.getTime() < dbNow.getTime()) {
        throw new Error('Recurring terminal result requires a future nextDueAt');
      }
      const firstBatch = batches[0];
      const scheduleUpdate: Record<string, unknown> = {
        leaseOwner: null,
        leaseExpiresAt: null,
        nextDueAt: input.nextDueAt,
        failureStreak: 0,
        circuitState: 'CLOSED',
        probeAfter: null,
        updatedAt: dbNow,
      };
      if (firstBatch) {
        scheduleUpdate.validator = firstBatch.validator;
        scheduleUpdate.cacheNotBefore = firstBatch.validator.cacheNotBefore
          ? new Date(firstBatch.validator.cacheNotBefore)
          : null;
      }
      if (input.checkpointComplete) {
        scheduleUpdate.checkpoint = input.checkpoint ?? {};
        checkpointAdvanced = true;
      }
      if (input.bootstrapCompleted) {
        scheduleUpdate.bootstrapCompletedAt = dbNow;
      }
      await tx
        .update(contentSourceSchedules)
        .set(scheduleUpdate)
        .where(eq(contentSourceSchedules.scheduleId, run.scheduleId));
    } else if (input.checkpointComplete) {
      throw new Error('Triggered run cannot advance a recurring schedule checkpoint');
    }

    const updatedRun = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: derivedState,
        resultCount: workItems.length,
        rejectedCount: input.rejections?.length ?? 0,
        runMetrics: input.runMetrics ?? {},
        provider: input.providerResult?.provider,
        providerUnits:
          input.providerResult?.providerUnits === null ||
          input.providerResult?.providerUnits === undefined
            ? undefined
            : String(input.providerResult.providerUnits),
        xCallCount:
          input.providerTraces?.filter((trace) => trace.provider === 'grok-build').length ?? 0,
        traceVerified:
          input.providerTraces?.some(
            (trace) => trace.provider === 'grok-build' && trace.terminalState === 'ATTESTED_FINAL',
          ) ?? false,
        failureClass: null,
        failureDetailsHash: null,
        errorSummary: null,
        checkpointAdvanced,
        completedAt: dbNow,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          eq(contentAcquisitionRuns.status, 'RUNNING'),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    if (updatedRun.length !== 1) throw new Error('Acquisition run terminal transition was lost');

    return {
      state: derivedState,
      receiptCount: workItems.length,
      revisionCount,
      unchangedCount,
      rejectedCount: input.rejections?.length ?? 0,
      outboxCount,
      checkpointAdvanced,
      triggeredJobCount,
    };
  });
}
