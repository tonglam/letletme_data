import type { EntrySyncJobName } from '../queues/entry-sync.queue';

type EventFinalizationState = {
  finished: boolean;
  dataChecked: boolean;
  dataCheckedAt: Date | null;
};

export function resolveRichResultFreshnessCutoff(
  event: EventFinalizationState | null,
): Date | null {
  return event?.finished && event.dataChecked ? event.dataCheckedAt : null;
}

export async function resolveEntrySyncTargetEventId(
  jobName: EntrySyncJobName,
  requestedEventId: number | undefined,
  findCurrentEventId: () => Promise<number | null>,
): Promise<number | undefined> {
  if (jobName === 'entry-info' || requestedEventId !== undefined) {
    return requestedEventId;
  }

  const currentEventId = await findCurrentEventId();
  if (currentEventId === null) {
    throw new Error('No current event found');
  }
  return currentEventId;
}
