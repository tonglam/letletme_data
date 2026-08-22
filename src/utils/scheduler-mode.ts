/**
 * Production Compose runs one no-port scheduler service.  API cron modules
 * remain registered for local/dev compatibility and for maintenance jobs that
 * are not yet in the registry, but critical registry-owned schedules must not
 * enqueue a second independent Bull job in standalone mode.
 */
export function isStandaloneSchedulerEnabled(): boolean {
  return process.env.SCHEDULER_MODE === 'standalone';
}

/**
 * During a rolling migration the API may still own the cron timer, but it must
 * use the same durable registry/reservation path as the standalone scheduler.
 * Keep the mode explicit so local development retains the historical direct
 * cron behavior unless an operator deliberately opts into the compatibility
 * bridge.
 */
export function isCompatibilitySchedulerEnabled(): boolean {
  return process.env.SCHEDULER_MODE === 'compatibility';
}
