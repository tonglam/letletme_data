export type RunnableQueueCounts = Readonly<Record<string, number>>;

export type QueueQuiescenceSnapshot = {
  readonly nonTerminalSyncRuns: number;
  readonly stagingPublications: number;
  readonly runningMediaLeases: number;
  readonly runnableQueues: Readonly<Record<string, RunnableQueueCounts>>;
  readonly unsettledCascadeIds: readonly string[];
};

export function assertQuiescenceCatalogPair(
  hasSyncRuns: boolean,
  hasDatasetPublications: boolean,
): void {
  if (hasSyncRuns !== hasDatasetPublications) {
    throw new Error(
      'Database has a partial quiescence catalog: ops.sync_runs and ops.dataset_publications must exist together',
    );
  }
}

export function runnableJobCount(counts: RunnableQueueCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function blockingRunnableJobCount(queueName: string, counts: RunnableQueueCounts): number {
  const delayed = counts.delayed ?? 0;
  if (queueName !== 'manager-live') {
    // Delayed jobs are durable scheduled/retry records.  They are not being
    // executed at the hard-cut boundary and BullMQ will resume them after the
    // new worker starts, so they must not make deployment impossible merely
    // because a scheduler has already placed its next tick in Redis.
    return Math.max(0, runnableJobCount(counts) - delayed);
  }
  // Manager-live jobs are versioned, idempotent cache/checkpoint refreshes.
  // Waiting/delayed/prioritized work may safely survive a hard cut and resume
  // on the new worker; active or structurally paused/parented work must still
  // settle before migration. This keeps the queue visible to the gate without
  // making a six-hour hot scope permanently block every deployment.
  return (counts.active ?? 0) + (counts.paused ?? 0) + (counts['waiting-children'] ?? 0);
}

/**
 * Deployment stops every writer before the migration boundary. Waiting,
 * delayed, and prioritized jobs are durable records that the new image can
 * resume, but an executing or structurally-owned job could be orphaned by the
 * schema change and must still block the cut.
 */
export function scopedBlockingRunnableJobCount(counts: RunnableQueueCounts): number {
  return (counts.active ?? 0) + (counts.paused ?? 0) + (counts['waiting-children'] ?? 0);
}

export function cascadeId(key: string): { id: string; settled: boolean } | null {
  const marker = ':tournament-cascade:';
  const markerIndex = key.indexOf(marker);
  if (markerIndex < 0) return null;

  const suffix = key.slice(markerIndex + marker.length);
  const separatorIndex = suffix.indexOf(':');
  if (separatorIndex < 1) return null;
  const kind = suffix.slice(0, separatorIndex);
  const remainder = suffix.slice(separatorIndex + 1);
  const idSeparatorIndex = remainder.indexOf(':');
  const id = idSeparatorIndex < 0 ? remainder : remainder.slice(0, idSeparatorIndex);
  if (!id) return null;

  return { id, settled: kind === 'refresh-enqueued' };
}

export function findUnsettledCascades(keys: readonly string[]): string[] {
  const state = new Map<string, boolean>();
  for (const key of keys) {
    const parsed = cascadeId(key);
    if (!parsed) continue;
    state.set(parsed.id, (state.get(parsed.id) ?? false) || parsed.settled);
  }
  return [...state.entries()]
    .filter(([, settled]) => !settled)
    .map(([id]) => id)
    .sort();
}

function assertDatabaseQuiescence(snapshot: QueueQuiescenceSnapshot): void {
  if (snapshot.nonTerminalSyncRuns !== 0) {
    throw new Error(`Database has ${snapshot.nonTerminalSyncRuns} non-terminal sync run(s)`);
  }
  if (snapshot.stagingPublications !== 0) {
    throw new Error(`Database has ${snapshot.stagingPublications} staging publication(s)`);
  }
  if (snapshot.runningMediaLeases !== 0) {
    throw new Error(`Database has ${snapshot.runningMediaLeases} RUNNING source-media lease(s)`);
  }
  if (snapshot.unsettledCascadeIds.length > 0) {
    throw new Error(
      `Tournament cascades are incomplete: ${snapshot.unsettledCascadeIds.join(', ')}`,
    );
  }
}

export function assertQueueQuiescence(snapshot: QueueQuiescenceSnapshot): void {
  assertDatabaseQuiescence(snapshot);

  const runnable = Object.entries(snapshot.runnableQueues)
    .filter(([queueName, counts]) => blockingRunnableJobCount(queueName, counts) !== 0)
    .map(([queueName, counts]) => `${queueName}=${JSON.stringify(counts)}`);
  if (runnable.length > 0) {
    throw new Error(`Queues still have runnable jobs: ${runnable.join(', ')}`);
  }
}

/**
 * Scoped deployment quiescence keeps the migration boundary safe without
 * requiring an unrelated waiting backlog to drain. It is intentionally
 * stricter than simply ignoring queue counts: active, paused, and
 * waiting-children jobs remain blockers, as do all durable database units.
 */
export function assertScopedQueueQuiescence(snapshot: QueueQuiescenceSnapshot): void {
  assertDatabaseQuiescence(snapshot);

  const blockers = Object.entries(snapshot.runnableQueues)
    .filter(([, counts]) => scopedBlockingRunnableJobCount(counts) !== 0)
    .map(([queueName, counts]) => `${queueName}=${JSON.stringify(counts)}`);
  if (blockers.length > 0) {
    throw new Error(`Queues still have active or structural jobs: ${blockers.join(', ')}`);
  }
}
