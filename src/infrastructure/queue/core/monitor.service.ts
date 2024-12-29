// Monitor service for queue operations
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { MonitorDependencies, MonitorOperations } from '../types';
import { createMonitorAdapter } from './monitor.adapter';

// Monitor service interface extending monitor operations
export interface MonitorService extends MonitorOperations {
  readonly getMonitor: (queueName: string) => O.Option<MonitorOperations>;
}

// Creates a monitor service with the given dependencies
export const createMonitorService = (deps: MonitorDependencies): MonitorService => {
  const monitors = new Map<string, MonitorOperations>();

  const getOrCreateMonitor = (queueName: string): MonitorOperations => {
    const existingMonitor = monitors.get(queueName);
    if (existingMonitor) {
      return existingMonitor;
    }

    const monitor = createMonitorAdapter(deps);
    monitors.set(queueName, monitor);
    return monitor;
  };

  const monitor = getOrCreateMonitor(deps.queue.name);

  return {
    ...monitor,
    getMonitor: (queueName: string) => pipe(monitors.get(queueName), O.fromNullable),
  };
};
