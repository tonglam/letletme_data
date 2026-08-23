import type { FplSeasonRef } from '../domain/fpl-season';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
  type EntrySyncJobOptions,
} from '../jobs/entry-sync-enqueue';
import type { EntrySyncJobSource } from '../queues/entry-sync.queue';
import { entryInfoRepository } from '../repositories/entry-infos';
import { eventRepository } from '../repositories/events';
import {
  captureMyFplSnapshot,
  dispatchMyFplSnapshotPublicationOutbox,
  getActiveMyFplPublication,
  type MyFplSnapshotCaptureResult,
  type MyFplSnapshotOutboxDispatchResult,
  type MyFplSnapshotPublication,
} from './my-fpl-snapshot-publication.service';
import { runQueueRunPhase, type QueuedJobReceipt } from './queue-run-barrier';

type EnqueueEntryJob = (
  season: FplSeasonRef,
  source: EntrySyncJobSource,
  options: EntrySyncJobOptions,
) => Promise<QueuedJobReceipt>;

type OnboardingEntry = Readonly<{
  id: number;
  startedEvent: number | null;
}>;

export type EntryOnboardingDependencies = Readonly<{
  runPhase: (
    runId: string,
    jobs: readonly Promise<QueuedJobReceipt>[],
  ) => Promise<readonly QueuedJobReceipt[]>;
  enqueueEntryInfo: EnqueueEntryJob;
  enqueueEntryPicks: EnqueueEntryJob;
  enqueueEntryResults: EnqueueEntryJob;
  enqueueEntryTransfers: EnqueueEntryJob;
  findEntry: (season: FplSeasonRef, entryId: number) => Promise<OnboardingEntry | null>;
  listFinalizedResultEventIds: (
    season: FplSeasonRef,
    firstEventId: number,
    currentEventId: number,
  ) => Promise<readonly number[]>;
  getActivePublication: (
    season: FplSeasonRef,
    eventId: number,
  ) => Promise<MyFplSnapshotPublication | null>;
  captureSnapshot: (
    season: FplSeasonRef,
    eventId: number,
    kind: 'PROVISIONAL',
  ) => Promise<MyFplSnapshotCaptureResult>;
  dispatchOutbox: () => Promise<MyFplSnapshotOutboxDispatchResult>;
}>;

export type EntryOnboardingResult = Readonly<{
  status: 'completed';
  entryId: number;
  eventId: number | null;
  attemptKey: string;
  stages: Readonly<{
    entryInfoJobId: string;
    eventDataStatus: 'completed' | 'skipped';
    eventDataSkipReason: 'PRESEASON' | 'NOT_STARTED' | null;
    picksJobId: string | null;
    resultsJobIds: readonly string[];
    transfersJobId: string | null;
  }>;
  snapshot:
    | Readonly<{
        status: 'published' | 'noop';
        revision: number;
        contentSha256: string;
      }>
    | Readonly<{
        status: 'skipped';
        reason: 'PRESEASON' | 'NO_PUBLICATION' | 'IMMUTABLE_FINAL';
        revision: number | null;
        contentSha256: string | null;
      }>;
  redis: MyFplSnapshotOutboxDispatchResult | null;
}>;

const runtimeDependencies: EntryOnboardingDependencies = {
  runPhase: (runId, jobs) => runQueueRunPhase(runId, jobs),
  enqueueEntryInfo: enqueueEntryInfoSyncJob,
  enqueueEntryPicks: enqueueEntryPicksSyncJob,
  enqueueEntryResults: enqueueEntryResultsSyncJob,
  enqueueEntryTransfers: enqueueEntryTransfersSyncJob,
  findEntry: async (season, entryId) => {
    const entries = await entryInfoRepository.findByIds(season, [entryId]);
    const entry = entries.find((candidate) => candidate.id === entryId);
    return entry ? { id: entry.id, startedEvent: entry.startedEvent } : null;
  },
  listFinalizedResultEventIds: async (season, firstEventId, currentEventId) =>
    (await eventRepository.findAll(season))
      .filter(
        (event) =>
          event.id >= firstEventId &&
          event.id <= currentEventId &&
          event.finished &&
          event.dataChecked,
      )
      .map((event) => event.id),
  getActivePublication: getActiveMyFplPublication,
  captureSnapshot: (season, eventId, kind) => captureMyFplSnapshot(season, eventId, kind),
  dispatchOutbox: () => dispatchMyFplSnapshotPublicationOutbox({ limit: 20 }),
};

function requireJobId(job: QueuedJobReceipt | undefined, stage: string): string {
  if (job?.id === undefined) throw new Error(`Entry onboarding ${stage} job has no ID`);
  return String(job.id);
}

function entryJobOptions(
  entryId: number,
  attemptKey: string,
  stage: 'entry-info' | 'entry-picks' | 'entry-results' | 'entry-transfers',
  eventId?: number,
): EntrySyncJobOptions {
  const eventScope = eventId === undefined ? '' : `-e${eventId}`;
  return {
    entryIds: [entryId],
    ...(eventId === undefined ? {} : { eventId }),
    jobId: `entry-onboarding-${attemptKey}-${stage}${eventScope}-${entryId}`,
    runId: attemptKey,
    queueKey: `entry-onboarding-${attemptKey}-${stage}${eventScope}-${entryId}`,
    removeOnSettle: false,
  };
}

/**
 * Coordinate a new entry from parent creation through event data and the
 * optional same-day provisional snapshot correction. Any failed child or
 * incomplete capture throws so BullMQ retries this parent while the previous
 * active publication remains untouched.
 */
export async function runEntryOnboarding(
  season: FplSeasonRef,
  input: Readonly<{ entryId: number; eventId?: number; attemptKey: string }>,
  dependencies: EntryOnboardingDependencies = runtimeDependencies,
): Promise<EntryOnboardingResult> {
  const entryInfoJobs = await dependencies.runPhase(input.attemptKey, [
    dependencies.enqueueEntryInfo(
      season,
      'api',
      entryJobOptions(input.entryId, input.attemptKey, 'entry-info', input.eventId),
    ),
  ]);
  const entryInfoJobId = requireJobId(entryInfoJobs[0], 'entry-info');
  const entry = await dependencies.findEntry(season, input.entryId);
  if (!entry) {
    throw new Error(`Entry onboarding could not load entry ${input.entryId} after entry-info sync`);
  }

  let eventDataStatus: EntryOnboardingResult['stages']['eventDataStatus'] = 'skipped';
  let eventDataSkipReason: EntryOnboardingResult['stages']['eventDataSkipReason'] =
    input.eventId === undefined ? 'PRESEASON' : 'NOT_STARTED';
  let picksJobId: string | null = null;
  let resultsJobIds: readonly string[] = [];
  let transfersJobId: string | null = null;
  const participatesInEvent =
    input.eventId !== undefined && (entry.startedEvent ?? 1) <= input.eventId;

  if (participatesInEvent) {
    const firstEventId = Math.max(1, entry.startedEvent ?? 1);
    const finalizedResultEventIds = await dependencies.listFinalizedResultEventIds(
      season,
      firstEventId,
      input.eventId!,
    );
    const resultEventIds = [
      ...new Set([
        ...finalizedResultEventIds.filter(
          (eventId) =>
            Number.isSafeInteger(eventId) && eventId >= firstEventId && eventId <= input.eventId!,
        ),
        input.eventId!,
      ]),
    ].sort((left, right) => left - right);
    const resultJobStartIndex = 1;
    const transfersJobIndex = resultJobStartIndex + resultEventIds.length;
    const eventJobs = await dependencies.runPhase(input.attemptKey, [
      dependencies.enqueueEntryPicks(
        season,
        'api',
        entryJobOptions(input.entryId, input.attemptKey, 'entry-picks', input.eventId),
      ),
      ...resultEventIds.map((resultEventId) =>
        dependencies.enqueueEntryResults(
          season,
          'api',
          entryJobOptions(input.entryId, input.attemptKey, 'entry-results', resultEventId),
        ),
      ),
      dependencies.enqueueEntryTransfers(
        season,
        'api',
        entryJobOptions(input.entryId, input.attemptKey, 'entry-transfers', input.eventId),
      ),
    ]);
    eventDataStatus = 'completed';
    eventDataSkipReason = null;
    picksJobId = requireJobId(eventJobs[0], 'entry-picks');
    resultsJobIds = eventJobs
      .slice(resultJobStartIndex, transfersJobIndex)
      .map((job, index) => requireJobId(job, `entry-results event ${resultEventIds[index]}`));
    transfersJobId = requireJobId(eventJobs[transfersJobIndex], 'entry-transfers');
  }

  const stages = {
    entryInfoJobId,
    eventDataStatus,
    eventDataSkipReason,
    picksJobId,
    resultsJobIds,
    transfersJobId,
  } as const;

  if (input.eventId === undefined) {
    return {
      status: 'completed',
      entryId: input.entryId,
      eventId: null,
      attemptKey: input.attemptKey,
      stages,
      snapshot: {
        status: 'skipped',
        reason: 'PRESEASON',
        revision: null,
        contentSha256: null,
      },
      redis: null,
    };
  }

  const active = await dependencies.getActivePublication(season, input.eventId);
  if (!active) {
    return {
      status: 'completed',
      entryId: input.entryId,
      eventId: input.eventId,
      attemptKey: input.attemptKey,
      stages,
      snapshot: {
        status: 'skipped',
        reason: 'NO_PUBLICATION',
        revision: null,
        contentSha256: null,
      },
      redis: null,
    };
  }
  if (active.kind === 'FINAL') {
    return {
      status: 'completed',
      entryId: input.entryId,
      eventId: input.eventId,
      attemptKey: input.attemptKey,
      stages,
      snapshot: {
        status: 'skipped',
        reason: 'IMMUTABLE_FINAL',
        revision: active.revision,
        contentSha256: active.contentSha256,
      },
      redis: null,
    };
  }

  const capture = await dependencies.captureSnapshot(season, input.eventId, 'PROVISIONAL');
  const redis = await dependencies.dispatchOutbox();
  return {
    status: 'completed',
    entryId: input.entryId,
    eventId: input.eventId,
    attemptKey: input.attemptKey,
    stages,
    snapshot: {
      status: capture.status,
      revision: capture.publication.revision,
      contentSha256: capture.publication.contentSha256,
    },
    redis,
  };
}
