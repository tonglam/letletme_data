import type { UnderstatSyncItem } from '../domain/understat';

export interface UnderstatFanoutTask {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly enqueue: () => Promise<unknown>;
}

export function selectUnsettledUnderstatFanoutIds(
  items: readonly UnderstatSyncItem[],
  resourceType: string,
): number[] {
  return [
    ...new Set(
      items
        .filter(
          (item) =>
            item.resourceType === resourceType &&
            (item.status === 'pending' || item.status === 'running'),
        )
        .map((item) => Number(item.resourceId))
        .filter((resourceId) => Number.isSafeInteger(resourceId) && resourceId > 0),
    ),
  ].sort((left, right) => left - right);
}

export async function enqueueUnderstatFanout(
  label: string,
  tasks: readonly UnderstatFanoutTask[],
): Promise<void> {
  const results = await Promise.allSettled(tasks.map(({ enqueue }) => enqueue()));
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const task = tasks[index]!;
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return [{ resourceType: task.resourceType, resourceId: task.resourceId, message }];
  });

  if (failures.length > 0) {
    throw new Error(
      `Failed to enqueue ${failures.length} ${label} job(s): ${failures
        .map(({ resourceType, resourceId, message }) => `${resourceType}:${resourceId}: ${message}`)
        .join('; ')}`,
    );
  }
}
