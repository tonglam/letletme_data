export type RunnableQueueCounts = Readonly<Record<string, number>>;

export type QueueQuiescenceSnapshot = {
  readonly nonTerminalSyncRuns: number;
  readonly stagingPublications: number;
  readonly runnableQueues: Readonly<Record<string, RunnableQueueCounts>>;
  readonly unsettledRetiredCascadeIds: readonly string[];
};

export function runnableJobCount(counts: RunnableQueueCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function retiredCascadeId(key: string): { id: string; settled: boolean } | null {
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

export function findUnsettledRetiredCascades(keys: readonly string[]): string[] {
  const state = new Map<string, boolean>();
  for (const key of keys) {
    const parsed = retiredCascadeId(key);
    if (!parsed) continue;
    state.set(parsed.id, (state.get(parsed.id) ?? false) || parsed.settled);
  }
  return [...state.entries()]
    .filter(([, settled]) => !settled)
    .map(([id]) => id)
    .sort();
}

export function assertQueueQuiescence(snapshot: QueueQuiescenceSnapshot): void {
  if (snapshot.nonTerminalSyncRuns !== 0) {
    throw new Error(`Database has ${snapshot.nonTerminalSyncRuns} non-terminal sync run(s)`);
  }
  if (snapshot.stagingPublications !== 0) {
    throw new Error(`Database has ${snapshot.stagingPublications} staging publication(s)`);
  }

  const runnable = Object.entries(snapshot.runnableQueues)
    .filter(([, counts]) => runnableJobCount(counts) !== 0)
    .map(([queueName, counts]) => `${queueName}=${JSON.stringify(counts)}`);
  if (runnable.length > 0) {
    throw new Error(
      `Retired or incompatible queues still have runnable jobs: ${runnable.join(', ')}`,
    );
  }

  if (snapshot.unsettledRetiredCascadeIds.length > 0) {
    throw new Error(
      `Retired tournament cascades are incomplete: ${snapshot.unsettledRetiredCascadeIds.join(', ')}`,
    );
  }
}
