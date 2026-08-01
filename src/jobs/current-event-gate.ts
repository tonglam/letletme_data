import type { Event } from '../types';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason } from '../utils/conditions';
import { logDebug, logInfo } from '../utils/logger';

export type CurrentEventGateDependencies = {
  isFPLSeason: (date: Date) => Promise<boolean>;
  getCurrentEvent: () => Promise<Event | null>;
};

const defaultDependencies: CurrentEventGateDependencies = {
  isFPLSeason,
  getCurrentEvent,
};

export async function shouldRunCurrentEventJob(
  jobName: string,
  date = new Date(),
  dependencies: CurrentEventGateDependencies = defaultDependencies,
): Promise<boolean> {
  if (!(await dependencies.isFPLSeason(date))) {
    logDebug('Skipping current-event job - not FPL season', {
      jobName,
      month: date.getMonth() + 1,
    });
    return false;
  }

  const currentEvent = await dependencies.getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping current-event job - no current event', { jobName });
    return false;
  }

  return true;
}
