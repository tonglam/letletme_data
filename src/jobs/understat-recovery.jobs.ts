import type { FplSeasonRef } from '../domain/fpl-season';
import { enqueueMaintenanceJob, type MaintenanceEnqueueOptions } from './maintenance.jobs';
import { MAINTENANCE_JOBS } from '../queues/maintenance.queue';

export const enqueueUnderstatOrphanReconciler = (
  season: FplSeasonRef,
  source: 'catchup' | 'schedule' | 'reconcile',
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.UNDERSTAT_ORPHAN_RECONCILER, source, options);
